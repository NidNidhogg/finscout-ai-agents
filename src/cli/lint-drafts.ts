/**
 * lint-drafts.ts — retroactive lint of existing 'drafted' queue items.
 *
 * Re-runs draft-linter on every drafted item's latest agent_run draft and
 * back-fills queue_items.draft_score / draft_violations_json, so drafts
 * generated before the linter existed get scored without re-running the agent.
 *
 * Usage:
 *   npx ts-node src/cli/lint-drafts.ts            # lint + write scores
 *   npx ts-node src/cli/lint-drafts.ts --dry-run  # report only, no writes
 *
 * Requires: nothing external — operates on REVIEW_DB_PATH only.
 */

import 'dotenv/config';
import Database from 'better-sqlite3';
import { EnrichedProfileSchema } from '../schema/enrichedProfile';
import { lintDraft } from '../services/draft-linter';

const DB_PATH = process.env['REVIEW_DB_PATH'] ?? 'data/review-queue.db';
const DRY_RUN = process.argv.includes('--dry-run');

interface Row {
  id: string;
  profile_json: string;
  draft_subject: string | null;
  draft_body: string | null;
}

function main(): void {
  const db = new Database(DB_PATH);

  const cols = (db.prepare('PRAGMA table_info(queue_items)').all() as { name: string }[])
    .map((c) => c.name);
  if (!cols.includes('draft_score')) {
    db.exec('ALTER TABLE queue_items ADD COLUMN draft_score REAL');
  }
  if (!cols.includes('draft_violations_json')) {
    db.exec('ALTER TABLE queue_items ADD COLUMN draft_violations_json TEXT');
  }

  const rows = db
    .prepare<[], Row>(`
      SELECT qi.id,
             qi.profile_json,
             ar.draft_subject,
             ar.draft_body
        FROM queue_items qi
        LEFT JOIN agent_runs ar
               ON ar.id = (
                    SELECT id FROM agent_runs
                     WHERE queue_item_id = qi.id
                     ORDER BY started_at DESC LIMIT 1
                  )
       WHERE qi.status = 'drafted'
    `)
    .all();

  if (rows.length === 0) {
    console.log('[lint-drafts] No drafted items found.');
    return;
  }

  console.log(`[lint-drafts] Linting ${rows.length} drafted item(s)${DRY_RUN ? ' (dry run)' : ''}…\n`);

  let clean = 0;
  let flagged = 0;
  let undrafted = 0;

  for (const row of rows) {
    const profile = EnrichedProfileSchema.parse(JSON.parse(row.profile_json));
    const label = profile.company.name;

    if (!row.draft_body?.trim()) {
      console.log(`  — ${label}: no draft body, skipped`);
      undrafted++;
      continue;
    }

    const lint = lintDraft(
      { subject: row.draft_subject ?? '', body: row.draft_body },
      profile,
    );

    if (!DRY_RUN) {
      db.prepare<[number, string, string], void>(
        'UPDATE queue_items SET draft_score = ?, draft_violations_json = ? WHERE id = ?',
      ).run(lint.score, JSON.stringify(lint.violations), row.id);
    }

    if (lint.violations.length === 0) {
      clean++;
      console.log(`  ✓ ${label} — clean (score ${lint.score.toFixed(2)})`);
    } else {
      flagged++;
      console.log(`  ⚠ ${label} — score ${lint.score.toFixed(2)}`);
      for (const v of lint.violations) {
        console.log(`      [${v.severity}] ${v.rule}: ${v.detail}`);
      }
    }
  }

  const total = rows.length - undrafted;
  console.log(
    `\n[lint-drafts] ${clean}/${total} clean · ${flagged} flagged` +
    (undrafted > 0 ? ` · ${undrafted} without draft body` : '') +
    (DRY_RUN ? ' — dry run, nothing written' : ' — scores written to queue_items'),
  );
}

main();
