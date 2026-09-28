/**
 * Module C — Agent Loop outreach draft generator.
 * Reads all `reviewed` queue items, runs AgentExecutionHarness for each
 * (research via Firecrawl + X tools → draft), writes a Markdown export,
 * and updates each record's status to `drafted` or `discarded`.
 *
 * Usage:
 *   npx ts-node src/cli/generate-outreach.ts
 *
 * Requires: GEMINI_API_KEY, FIRECRAWL_API_KEY, X_BEARER_TOKEN
 *           REVIEW_DB_PATH (optional, defaults to data/review-queue.db)
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { EnrichedProfileSchema, ReviewAnnotationSchema } from '../schema/enrichedProfile';
import { AgentExecutionHarness, NO_SIGNALS_SENTINEL } from '../agent/AgentExecutionHarness';
import type { RunContext } from '../agent/AgentExecutionHarness';
import { lintDraft } from '../services/draft-linter';

// ── Config ────────────────────────────────────────────────────────────────────

const DB_PATH = process.env['REVIEW_DB_PATH'] ?? 'data/review-queue.db';
const EXPORTS_DIR = 'data/exports';
const MODEL = process.env['GEMINI_MODEL'] ?? 'gemini-2.5-flash';

// ── Types ─────────────────────────────────────────────────────────────────────

interface QueueRow {
  id: string;
  profile_json: string;
  annotation_json: string | null;
}

interface EmailDraft {
  profileId: string;
  companyName: string;
  xHandle: string | null;
  websiteUrl: string | null;
  founderName: string | null;
  subject: string;
  body: string;
  budgetExhausted: boolean;
  lintScore: number;
  lintViolations: string[];
}

// ── queue_items column migration ──────────────────────────────────────────────

function ensureDraftLintColumns(db: Database.Database): void {
  const cols = (db.prepare('PRAGMA table_info(queue_items)').all() as { name: string }[])
    .map((c) => c.name);
  if (!cols.includes('draft_score')) {
    db.exec('ALTER TABLE queue_items ADD COLUMN draft_score REAL');
  }
  if (!cols.includes('draft_violations_json')) {
    db.exec('ALTER TABLE queue_items ADD COLUMN draft_violations_json TEXT');
  }
}

// ── Source routing ────────────────────────────────────────────────────────────

type LeadSource = 'cryptorank' | 'funding-radar' | 'x-radar' | 'defillama' | 'unknown';

function detectSource(profile: ReturnType<typeof EnrichedProfileSchema.parse>): LeadSource {
  const rawText = profile.funding.claimed?.rawText ?? '';
  if (rawText.startsWith('CryptoRank:')) return 'cryptorank';
  if (rawText.startsWith('Funding Radar:')) return 'funding-radar';
  if (rawText.startsWith('X-Radar:')) return 'x-radar';
  if (rawText.startsWith('DefiLlama TVL:')) return 'defillama';
  return 'unknown';
}

const SOURCE_ANGLE: Record<LeadSource, string> = {
  cryptorank:      'CryptoRank Funding Radar — recent raise (MVA / post-raise technical debt prevention)',
  'funding-radar': 'DefiLlama Raises — recently funded Web3 project (MVA / post-raise technical debt prevention)',
  'x-radar':       'X Funding Radar — announced raise detected via Twitter/X (MVA / post-raise technical debt prevention)',
  defillama:       'DefiLlama — live on-chain protocol (Zero-Trust, HSM, high-load security)',
  unknown:         'direct / manual injection',
};

const FRAMEWORK_BY_SOURCE: Record<LeadSource, { hypothesis: string; valueDrop: string }> = {
  'x-radar': {
    hypothesis:
      'Name a precise architectural risk implied by their stack and raise stage. ' +
      'Focus on post-raise technical debt traps: premature abstractions locked in at MVP phase, ' +
      'synchronous bottlenecks that survive into production, missing observability at persistence ' +
      'boundaries, or auth/key management shortcuts that compound into security liabilities at scale.',
    valueDrop:
      'One sentence on how iDECP\'s MVA approach eliminates this. ' +
      'Angle: a 6–12 week Minimum Viable Architecture engagement avoids the ' +
      '"quick and dirty" trap — the architectural choices made in weeks 1–4 post-raise that cause ' +
      '70% of teams to hit a hard scaling wall at 12 months. 40% less technical debt, no throwaway code.',
  },
  'funding-radar': {
    hypothesis:
      'Name a precise architectural risk implied by their stack and raise stage. ' +
      'Focus on post-raise technical debt traps: premature abstractions locked in at MVP phase, ' +
      'synchronous bottlenecks that survive into production, missing observability at persistence ' +
      'boundaries, or auth/key management shortcuts that compound into security liabilities at scale.',
    valueDrop:
      'One sentence on how iDECP\'s MVA approach eliminates this. ' +
      'Angle: a 6–12 week Minimum Viable Architecture engagement avoids the ' +
      '"quick and dirty" trap — the architectural choices made in weeks 1–4 post-raise that cause ' +
      '70% of teams to hit a hard scaling wall at 12 months. 40% less technical debt, no throwaway code.',
  },
  cryptorank: {
    hypothesis:
      'Name a precise architectural risk implied by their stack and raise stage. ' +
      'Focus on post-raise technical debt traps: premature abstractions locked in at MVP phase, ' +
      'synchronous bottlenecks that survive into production, missing observability at persistence ' +
      'boundaries, or auth/key management shortcuts that compound into security liabilities at scale.',
    valueDrop:
      'One sentence on how iDECP\'s MVA approach eliminates this. ' +
      'Angle: a 6–12 week Minimum Viable Architecture engagement avoids the ' +
      '"quick and dirty" trap — the architectural choices made in weeks 1–4 post-raise that cause ' +
      '70% of teams to hit a hard scaling wall at 12 months. 40% less technical debt, no throwaway code.',
  },
  defillama: {
    hypothesis:
      'Name a precise architectural, scaling, or security challenge implied by their signals ' +
      '(e.g., multi-sig coordination under load, settlement finality risk under adversarial conditions, ' +
      'key management at HSM tier, intent-relay latency).',
    valueDrop:
      'One sentence on how iDECP addresses this. ' +
      'Choose the angle that fits: Zero-Trust backends, MVA for high-load async systems, ' +
      'cross-chain security primitives, or HSM-grade key management.',
  },
  unknown: {
    hypothesis:
      'Name a precise architectural, scaling, or security challenge implied by their signals ' +
      '(e.g., multi-sig coordination under load, settlement finality risk under adversarial conditions, ' +
      'key management at HSM tier, intent-relay latency).',
    valueDrop:
      'One sentence on how iDECP addresses this. ' +
      'Choose the angle that fits: Minimum Viable Architecture, Zero-Trust backends, ' +
      'cross-chain security primitives, high-load async systems, or HSM-grade key management.',
  },
};

// ── Markdown rendering ────────────────────────────────────────────────────────

function renderMarkdown(drafts: EmailDraft[], generatedAt: string): string {
  const header = [
    '# iDECP Outreach Drafts — Agent Loop',
    '',
    `**Generated:** ${generatedAt}  `,
    `**Model:** ${MODEL}  `,
    `**Drafts:** ${drafts.length}`,
    '',
    '> Human-in-the-loop. Review each draft, edit as needed, send manually.',
    '',
    '---',
    '',
  ].join('\n');

  const sections = drafts.map((d, i) => {
    // When xHandle is verified, show it; otherwise anchor on the website domain.
    let identifier = d.xHandle ?? '';
    if (!identifier && d.websiteUrl) {
      try { identifier = new URL(d.websiteUrl).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
    }
    const contactLabel = d.founderName ? ` · attn: ${d.founderName}` : '';
    const lines = [
      `## ${i + 1}. ${d.companyName} · ${identifier || '(no handle)'}${contactLabel}`,
      '',
    ];
    if (d.budgetExhausted) {
      lines.push('> **Note:** Draft produced via fallback after iteration budget exhausted.', '');
    }
    if (d.lintViolations.length > 0) {
      lines.push(
        `> **Lint score ${d.lintScore.toFixed(2)}** — ${d.lintViolations.join(' · ')}`,
        '',
      );
    }
    lines.push(`**Subject:** \`${d.subject}\``, '', '```', d.body, '```', '', '---', '');
    return lines.join('\n');
  });

  return header + sections.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const geminiApiKey = process.env['GEMINI_API_KEY'];
  if (!geminiApiKey) {
    console.error('[generate-outreach] ERROR: GEMINI_API_KEY is required.');
    process.exit(1);
  }

  const firecrawlApiKey = process.env['FIRECRAWL_API_KEY'];
  if (!firecrawlApiKey) {
    console.error('[generate-outreach] ERROR: FIRECRAWL_API_KEY is required.');
    process.exit(1);
  }

  const xBearerToken = process.env['X_BEARER_TOKEN'];
  if (!xBearerToken) {
    console.error('[generate-outreach] ERROR: X_BEARER_TOKEN is required.');
    process.exit(1);
  }

  const db = new Database(DB_PATH);
  ensureDraftLintColumns(db);

  const harness = new AgentExecutionHarness({
    db,
    geminiApiKey,
    firecrawlApiKey,
    xBearerToken,
    model: MODEL,
  });

  const rows = db
    .prepare<[], QueueRow>(
      `SELECT id, profile_json, annotation_json FROM queue_items WHERE status = 'reviewed'`,
    )
    .all();

  if (rows.length === 0) {
    console.log('[generate-outreach] No reviewed profiles found. Nothing to draft.');
    process.exit(0);
  }

  console.log(`[generate-outreach] Found ${rows.length} reviewed profile(s). Running agent loop…\n`);

  const drafts: EmailDraft[] = [];
  let discarded = 0;
  let failed = 0;
  let totalCostUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (const row of rows) {
    const profile = EnrichedProfileSchema.parse(JSON.parse(row.profile_json));

    // Hard stop: skip manually-reviewed Tier C profiles that slipped through
    if (row.annotation_json) {
      const annotation = ReviewAnnotationSchema.parse(JSON.parse(row.annotation_json));
      if (annotation.tier === 'C') {
        const companyLabel = `${profile.company.name} (${profile.company.xHandle ?? row.id.slice(0, 8)})`;
        console.log(`  ⊘ ${companyLabel} — Tier C (${annotation.tierReason}) → skipped`);
        discarded++;
        continue;
      }
    }

    const source = detectSource(profile);
    const framework = FRAMEWORK_BY_SOURCE[source];

    const context: RunContext = {
      sourceAngle: SOURCE_ANGLE[source],
      hypothesis: framework.hypothesis,
      valueDrop: framework.valueDrop,
    };

    // Resolve primary contact: prefer extracted founder, fall back to company handle.
    const primaryFounder = profile.team.founders[0];
    const founderFirstName = primaryFounder?.name?.trim().split(/\s+/)[0] ?? null;

    const companyLabel = `${profile.company.name} (${profile.company.xHandle ?? row.id.slice(0, 8)})`;
    const contactNote  = founderFirstName ? ` → ${founderFirstName}` : '';
    process.stdout.write(`  → ${companyLabel}${contactNote} [${source}]… `);

    try {
      const record = await harness.run(row.id, context);

      const isNoSignals =
        record.draftBody === NO_SIGNALS_SENTINEL ||
        (record.status === 'budget_exhausted' && !record.draftBody?.trim());

      if (isNoSignals) {
        console.log('agent found no signals → discarded');
        discarded++;
      } else {
        const lint = lintDraft(
          { subject: record.draftSubject ?? '', body: record.draftBody ?? '' },
          profile,
        );
        db.prepare<[number, string, string], void>(
          'UPDATE queue_items SET draft_score = ?, draft_violations_json = ? WHERE id = ?',
        ).run(lint.score, JSON.stringify(lint.violations), row.id);
        drafts.push({
          profileId: row.id,
          companyName: profile.company.name,
          xHandle: profile.company.xHandle ?? null,
          websiteUrl: profile.company.websiteUrl ?? null,
          founderName: founderFirstName,
          subject: record.draftSubject ?? '(no subject)',
          body: record.draftBody ?? '',
          budgetExhausted: record.status === 'budget_exhausted',
          lintScore: lint.score,
          lintViolations: lint.violations.map((v) => `${v.rule}: ${v.detail}`),
        });
        const budgetNote =
          record.status === 'budget_exhausted' ? ` [budget_exhausted @ iter ${record.iterationCount}]` : '';
        totalCostUsd += record.costUsd;
        totalInputTokens += record.inputTokens;
        totalOutputTokens += record.outputTokens;
        console.log(
          `done (${record.iterationCount} iteration(s)${budgetNote}` +
          ` · cost $${record.costUsd.toFixed(4)} · ${record.inputTokens}+${record.outputTokens} tok)`,
        );
        if (lint.violations.length > 0) {
          console.log(
            `     ⚠ lint score ${lint.score.toFixed(2)}: ${lint.violations.map((v) => v.rule).join(', ')}`,
          );
        }
      }
    } catch (err: unknown) {
      console.log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
      // Safety-net: if the harness threw before its own catch block could execute
      // (e.g. an error between SET agent-running and the harness try block), force
      // the item back to 'reviewed' so it is not orphaned in 'agent-running'.
      // The AND guard makes this a no-op when the harness already rolled back.
      db.prepare<[string], void>(
        "UPDATE queue_items SET status = 'reviewed' WHERE id = ? AND status = 'agent-running'",
      ).run(row.id);
      failed++;
    }
  }

  fs.mkdirSync(EXPORTS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '');
  const fileTs = ts.replace(/[ :]/g, '-');
  const outPath = path.join(EXPORTS_DIR, `outreach-drafts-${fileTs}.md`);
  fs.writeFileSync(outPath, renderMarkdown(drafts, ts), 'utf-8');

  console.log(`\n[generate-outreach] ${drafts.length} draft(s) written → ${outPath}`);
  if (totalCostUsd > 0) {
    const perLead = drafts.length > 0 ? totalCostUsd / drafts.length : 0;
    console.log(
      `[generate-outreach] LLM cost: $${totalCostUsd.toFixed(4)} total` +
      ` ($${perLead.toFixed(4)}/draft · ${totalInputTokens}+${totalOutputTokens} tok)`,
    );
  }
  if (discarded > 0)
    console.log(`[generate-outreach] ${discarded} discarded (agent found no technical signals).`);
  if (failed > 0)
    console.log(`[generate-outreach] ${failed} failed (agent error — status rolled back to reviewed).`);
}

main().catch((err: unknown) => {
  console.error('[generate-outreach] Fatal:', err);
  process.exit(1);
});
