/**
 * run-evals.ts — live eval contour for the outreach agent.
 *
 * Loads golden EnrichedProfile fixtures from src/evals/golden/, runs each
 * through the real AgentExecutionHarness (live LLM + live tools), then lints
 * the draft and asserts the eval contract:
 *   - a draft is produced (not NO_SIGNALS_FOUND, non-empty)
 *   - zero hard lint violations (invented handle, missing subject, …)
 *   - lint score >= EVAL_MIN_SCORE (default 0.9)
 *
 * Usage:
 *   npx ts-node src/evals/run-evals.ts
 *
 * Requires: GEMINI_API_KEY. External tools are stubbed from each fixture's
 * rawContent — no FIRECRAWL_API_KEY or X_BEARER_TOKEN needed.
 * Env: EVAL_DB_PATH (default data/evals-queue.db, reset each run),
 *      GEMINI_MODEL, EVAL_MIN_SCORE (default 0.9),
 *      EVAL_LIVE_TOOLS=1 — also run live-*.json fixtures against the real
 *      Firecrawl/X APIs (needs FIRECRAWL_API_KEY + X_BEARER_TOKEN).
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { EnrichedProfileSchema } from '../schema/enrichedProfile';
import type { EnrichedProfile } from '../schema/enrichedProfile';
import { AgentExecutionHarness, NO_SIGNALS_SENTINEL } from '../agent/AgentExecutionHarness';
import type { RunContext } from '../agent/AgentExecutionHarness';
import { lintDraft } from '../services/draft-linter';
import { detectSource, FRAMEWORK_BY_SOURCE, SOURCE_ANGLE } from '../services/source-routing';
import { FixturePageFetcher, FixtureXApiClient } from './stub-tools';

// ── Config ─────────────────────────────────────────────────────────────────────

const DB_PATH = process.env['EVAL_DB_PATH'] ?? 'data/evals-queue.db';
const GOLDEN_DIR = path.join(__dirname, 'golden');
const REPORT_PATH = 'data/evals-report.json';
const MODEL = process.env['GEMINI_MODEL'] ?? 'gemini-2.5-flash';
const MIN_SCORE = Number(process.env['EVAL_MIN_SCORE'] ?? '0.9');
// Fixtures named live-*.json run against real Firecrawl/X (skipped otherwise).
const LIVE_TOOLS = process.env['EVAL_LIVE_TOOLS'] === '1';

// ── Types ──────────────────────────────────────────────────────────────────────

interface EvalResult {
  fixture: string;
  company: string;
  source: string;
  status: string;
  iterationCount: number;
  costUsd: number;
  lintScore: number;
  violations: string[];
  passed: boolean;
  failReasons: string[];
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function loadFixtures(): { file: string; profile: EnrichedProfile }[] {
  const files = fs.readdirSync(GOLDEN_DIR).filter((f) => f.endsWith('.json')).sort();
  return files.map((file) => ({
    file,
    profile: EnrichedProfileSchema.parse(
      JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, file), 'utf8')),
    ),
  }));
}

function resetDb(dbPath: string): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  if (fs.existsSync(dbPath)) fs.rmSync(dbPath);
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE queue_items (
      id              TEXT PRIMARY KEY,
      profile_json    TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending',
      enqueued_at     TEXT NOT NULL,
      reviewed_at     TEXT,
      annotation_json TEXT,
      draft_score     REAL,
      draft_violations_json TEXT
    )
  `);
  return db;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const geminiApiKey = process.env['GEMINI_API_KEY'];
  if (!geminiApiKey) {
    console.error('[evals] ERROR: GEMINI_API_KEY is required.');
    process.exit(1);
  }
  // Tool stubs serve fixture rawContent, so no Firecrawl/X credentials needed.

  const fixtures = loadFixtures();
  if (fixtures.length === 0) {
    console.error(`[evals] No fixtures in ${GOLDEN_DIR}`);
    process.exit(1);
  }

  const db = resetDb(DB_PATH);

  console.log(
    `[evals] ${fixtures.length} golden fixture(s) · model ${MODEL} · min score ${MIN_SCORE}\n`,
  );

  const results: EvalResult[] = [];

  for (const { file, profile } of fixtures) {
    const live = file.startsWith('live-');
    if (live && !LIVE_TOOLS) {
      console.log(`  ⊘ ${profile.company.name} [live]… skipped (set EVAL_LIVE_TOOLS=1 to run)`);
      continue;
    }
    db.prepare(
      `INSERT INTO queue_items (id, profile_json, status, enqueued_at)
       VALUES (?, ?, 'reviewed', ?)`,
    ).run(profile.id, JSON.stringify(profile), new Date().toISOString());

    const source = detectSource(profile);
    const context: RunContext = {
      sourceAngle: SOURCE_ANGLE[source],
      hypothesis: FRAMEWORK_BY_SOURCE[source].hypothesis,
      valueDrop: FRAMEWORK_BY_SOURCE[source].valueDrop,
    };

    process.stdout.write(`  → ${profile.company.name} [${source}]… `);

    const failReasons: string[] = [];
    try {
      // Fixture tools serve the golden profile's own rawContent — the LLM and
      // harness stay live; only external I/O is stubbed for determinism.
      // live-* fixtures skip the stubs and hit real Firecrawl/X.
      if (live && (!process.env['FIRECRAWL_API_KEY'] || !process.env['X_BEARER_TOKEN'])) {
        console.log('SKIP  live fixture needs FIRECRAWL_API_KEY + X_BEARER_TOKEN');
        continue;
      }
      const harness = new AgentExecutionHarness({
        db,
        geminiApiKey,
        firecrawlApiKey: process.env['FIRECRAWL_API_KEY'] ?? '',
        xBearerToken: process.env['X_BEARER_TOKEN'] ?? '',
        model: MODEL,
        ...(live ? {} : {
          pageFetcher: new FixturePageFetcher(profile),
          xApiClient: new FixtureXApiClient(profile),
        }),
      });
      const record = await harness.run(profile.id, context);
      const body = record.draftBody ?? '';
      const subject = record.draftSubject ?? '';

      const lint = lintDraft({ subject, body }, profile);
      db.prepare(
        `UPDATE queue_items SET draft_score = ?, draft_violations_json = ?,
                status = 'drafted' WHERE id = ?`,
      ).run(lint.score, JSON.stringify(lint.violations), profile.id);

      if (!body.trim() || body === NO_SIGNALS_SENTINEL) {
        failReasons.push(`no draft produced (status=${record.status})`);
      }
      for (const v of lint.violations) {
        if (v.severity === 'hard') failReasons.push(`hard violation: ${v.rule}`);
      }
      if (lint.score < MIN_SCORE) {
        failReasons.push(`lint score ${lint.score.toFixed(2)} < ${MIN_SCORE}`);
      }

      const passed = failReasons.length === 0;
      console.log(
        `${passed ? 'PASS' : 'FAIL'}  score=${lint.score.toFixed(2)} ` +
        `iters=${record.iterationCount} cost=$${record.costUsd.toFixed(4)}` +
        (passed ? '' : `\n      ${failReasons.join('\n      ')}`),
      );

      results.push({
        fixture: file,
        company: profile.company.name,
        source,
        status: record.status,
        iterationCount: record.iterationCount,
        costUsd: record.costUsd,
        lintScore: lint.score,
        violations: lint.violations.map((v) => `${v.severity}:${v.rule}`),
        passed,
        failReasons,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`FAIL  harness threw: ${msg}`);
      results.push({
        fixture: file, company: profile.company.name, source,
        status: 'error', iterationCount: 0, costUsd: 0, lintScore: 0,
        violations: [], passed: false, failReasons: [msg],
      });
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const totalCost = results.reduce((s, r) => s + r.costUsd, 0);
  console.log(
    `\n[evals] ${passed}/${results.length} passed · total cost $${totalCost.toFixed(4)}`,
  );

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify({ model: MODEL, results }, null, 2));
  console.log(`[evals] report → ${REPORT_PATH}`);

  if (passed !== results.length) process.exit(1);
}

main().catch((err: unknown) => {
  console.error('[evals] Fatal:', err);
  process.exit(1);
});
