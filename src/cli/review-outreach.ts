/**
 * HITL Review CLI — Human-in-the-Loop review of drafted outreach emails.
 *
 * Presents every 'drafted' item sorted Tier A → B → C. For each:
 *   ✅  Approve & Send    → MockMailSender.send() → status 'sent'
 *   ✏️   Edit Draft        → spawn $EDITOR via spawnSync → re-render
 *   🗑️   Reject / Discard  → status 'discarded'
 *   ⏭️   Skip for Now      → move to next item
 *
 * Usage:
 *   npx ts-node src/cli/review-outreach.ts
 *   EDITOR=vim npx ts-node src/cli/review-outreach.ts
 */

import 'dotenv/config';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import { prompt } from 'enquirer';
import { EnrichedProfileSchema } from '../schema/enrichedProfile';
import type { ReviewAnnotation } from '../schema/enrichedProfile';
import { MockMailSender } from '../services/mail-sender';
import type { EmailDraft } from '../services/mail-sender';

// ── Config ─────────────────────────────────────────────────────────────────────

const DB_PATH = process.env['REVIEW_DB_PATH'] ?? 'data/review-queue.db';

// ── ANSI ───────────────────────────────────────────────────────────────────────

const A = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  cyan:    '\x1b[36m',
  white:   '\x1b[37m',
};

// ── Tier helpers ───────────────────────────────────────────────────────────────

function tierBadge(tier: string | null): string {
  if (tier === 'A') return `${A.bold}${A.red}[🔥 TIER A: MEGA HOT]${A.reset}`;
  if (tier === 'B') return `${A.bold}${A.yellow}[🟡 TIER B: WARM]${A.reset}`;
  if (tier === 'C') return `${A.white}[⚪ TIER C: COLD]${A.reset}`;
  return `${A.dim}[— UNTIERED]${A.reset}`;
}

// ── Types ──────────────────────────────────────────────────────────────────────

interface DraftedRow {
  id:              string;
  profile_json:    string;
  annotation_json: string | null;
  draft_subject:   string | null;
  draft_body:      string | null;
}

interface DraftedItem {
  id:           string;
  profile:      ReturnType<typeof EnrichedProfileSchema.parse>;
  tier:         string | null;
  tierReason:   string | null;
  draftSubject: string;
  draftBody:    string;
}

// ── Display ────────────────────────────────────────────────────────────────────

const RULE  = '═'.repeat(66);
const HRULE = '─'.repeat(66);

function displayItem(item: DraftedItem, index: number, total: number): void {
  const { profile, tier, tierReason, draftSubject, draftBody } = item;
  const co = profile.company;

  console.log(`\n${A.bold}${RULE}${A.reset}`);
  console.log(
    `  🏢  ${A.bold}${co.name}${A.reset}` +
    (co.xHandle ? `   ${A.dim}${co.xHandle}${A.reset}` : ''),
  );
  if (co.websiteUrl) {
    console.log(`  🌐  ${A.cyan}${co.websiteUrl}${A.reset}`);
  }
  console.log(`${A.bold}${RULE}${A.reset}`);
  console.log(`  🎯  ${tierBadge(tier)}`);
  if (tierReason) {
    // Word-wrap tierReason at ~58 chars so it stays inside the box
    const words = tierReason.split(' ');
    const wrapped: string[] = [];
    let line = '';
    for (const word of words) {
      if ((line + ' ' + word).trim().length > 58) {
        wrapped.push(line.trim());
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    if (line) wrapped.push(line.trim());
    wrapped.forEach((l, i) =>
      console.log(`  🪝  ${i === 0 ? '' : '     '}${A.dim}${l}${A.reset}`),
    );
  }
  console.log(HRULE);
  console.log(`  ✉️   ${A.bold}SUBJECT:${A.reset} ${A.cyan}${draftSubject}${A.reset}`);
  console.log(HRULE);
  draftBody.split('\n').forEach((line) => {
    console.log(`  ${line}`);
  });
  console.log(`${A.bold}${RULE}${A.reset}`);
  console.log(`  ${A.dim}Item ${index + 1} of ${total}${A.reset}`);
}

// ── Editor ─────────────────────────────────────────────────────────────────────

function runEditor(db: Database.Database, item: DraftedItem): { subject: string; body: string } {
  const tmpFile = path.join(os.tmpdir(), `idec-draft-${item.id.slice(0, 8)}.txt`);

  fs.writeFileSync(
    tmpFile,
    `SUBJECT: ${item.draftSubject}\n\n${item.draftBody}`,
    'utf-8',
  );

  // Try VS Code first (--wait blocks until the tab is closed), fall back to nano.
  let usedEditor = 'code';
  try {
    console.log(`\n  Opening ${A.bold}VS Code${A.reset}…  (save and close the tab to apply)\n`);
    const result = spawnSync('code', ['--wait', tmpFile], { stdio: 'inherit' });
    if (result.error) throw result.error;
  } catch {
    usedEditor = 'nano';
    console.log(`\n  VS Code unavailable — opening ${A.bold}nano${A.reset}…  (Ctrl+X to save and exit)\n`);
    spawnSync('nano', [tmpFile], { stdio: 'inherit' });
  }
  void usedEditor;

  const updated = fs.readFileSync(tmpFile, 'utf-8');
  try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }

  const lines = updated.split('\n');
  const subjectIdx = lines.findIndex((l) => l.toLowerCase().startsWith('subject:'));
  const subjectLine = subjectIdx >= 0 ? lines[subjectIdx] : null;
  const newSubject = subjectLine
    ? subjectLine.replace(/^subject:\s*/i, '').trim()
    : item.draftSubject;
  const newBody = (subjectIdx >= 0 ? lines.slice(subjectIdx + 1) : lines)
    .join('\n')
    .replace(/^\n+/, '')
    .trim();

  // Persist to the most recent agent_run for this queue item
  db.prepare(`
    UPDATE agent_runs
       SET draft_subject = ?, draft_body = ?
     WHERE id = (
       SELECT id FROM agent_runs
        WHERE queue_item_id = ?
        ORDER BY started_at DESC LIMIT 1
     )
  `).run(newSubject, newBody, item.id);

  return { subject: newSubject, body: newBody };
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let db: Database.Database;
  try {
    db = new Database(DB_PATH);
  } catch {
    console.error(`[review-outreach] Cannot open "${DB_PATH}". Run a fetch/inject script first.`);
    process.exit(1);
  }

  const sender = new MockMailSender();

  // Fetch all drafted items, joining their latest agent_run for the draft text.
  // Sort: Tier A → B → C → untiered, then freshest first within each tier.
  // Items backed by an agent_run (have draft text) surface before draft-less ones.
  const rows = db
    .prepare<[], DraftedRow>(`
      SELECT qi.id,
             qi.profile_json,
             qi.annotation_json,
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
       ORDER BY
         CASE json_extract(qi.annotation_json, '$.tier')
           WHEN 'A' THEN 0
           WHEN 'B' THEN 1
           WHEN 'C' THEN 2
           ELSE 3
         END ASC,
         (ar.draft_subject IS NOT NULL) DESC,
         qi.enqueued_at DESC
    `)
    .all();

  if (rows.length === 0) {
    console.log('[review-outreach] No drafted items found. Run generate-outreach.ts (or inject-checker.ts) first.');
    return;
  }

  // Parse and sort Tier A → B → C → untiered
  const items: DraftedItem[] = rows
    .map((row): DraftedItem => {
      const profile = EnrichedProfileSchema.parse(JSON.parse(row.profile_json));
      let tier: string | null = null;
      let tierReason: string | null = null;
      if (row.annotation_json) {
        const ann = JSON.parse(row.annotation_json) as Partial<ReviewAnnotation>;
        tier = ann.tier ?? null;
        tierReason = ann.tierReason ?? null;
      }
      return {
        id:           row.id,
        profile,
        tier,
        tierReason,
        draftSubject: row.draft_subject ?? '(no draft — re-run generate-outreach)',
        draftBody:    row.draft_body    ?? '(no draft body — re-run generate-outreach to produce outreach copy for this lead)',
      };
    });

  // Summary header
  const tierCounts = { A: 0, B: 0, C: 0, other: 0 };
  for (const item of items) {
    if (item.tier === 'A') tierCounts.A++;
    else if (item.tier === 'B') tierCounts.B++;
    else if (item.tier === 'C') tierCounts.C++;
    else tierCounts.other++;
  }

  console.log(`\n${A.bold}  iDECP OUTREACH — HITL REVIEW${A.reset}`);
  console.log(
    `  ${items.length} drafted  ·  ` +
    `${A.bold}${A.red}A: ${tierCounts.A}${A.reset}  ` +
    `${A.bold}${A.yellow}B: ${tierCounts.B}${A.reset}  ` +
    `${A.white}C: ${tierCounts.C}${A.reset}` +
    (tierCounts.other > 0 ? `  untiered: ${tierCounts.other}` : ''),
  );

  let sent = 0;
  let discarded = 0;
  let skipped = 0;

  for (let i = 0; i < items.length; i++) {
    let item = items[i]!;

    // Inner loop so Edit re-renders without advancing to the next item
    while (true) {
      console.clear();
      displayItem(item, i, items.length);

      let action: string;
      try {
        const result = await prompt<{ action: string }>({
          type: 'select',
          name: 'action',
          message: 'Action:',
          choices: [
            { name: 'send',    message: '✅  Approve & Send' },
            { name: 'edit',    message: '✏️   Edit Draft' },
            { name: 'discard', message: '🗑️   Reject / Discard' },
            { name: 'skip',    message: '⏭️   Skip for Now' },
          ],
        });
        action = result.action;
      } catch {
        // Ctrl+C / Escape — exit gracefully
        console.log('\n[review-outreach] Session interrupted.');
        console.log(`[review-outreach] ${sent} sent · ${discarded} discarded · ${skipped} skipped.`);
        return;
      }

      if (action === 'send') {
        const draft: EmailDraft = {
          profileId:       item.id,
          companyName:     item.profile.company.name,
          xHandle:         item.profile.company.xHandle ?? '',
          subject:         item.draftSubject,
          body:            item.draftBody,
          budgetExhausted: false,
        };

        console.log();
        const success = await sender.send(draft, item.profile);

        if (success) {
          // Guard against double-send: only update if still drafted
          db.prepare(
            `UPDATE queue_items SET status = 'sent' WHERE id = ? AND status = 'drafted'`,
          ).run(item.id);
          console.log(
            `\n  ${A.bold}${A.green}✓${A.reset} ${A.bold}${item.profile.company.name}${A.reset} ` +
            `marked as ${A.bold}${A.green}sent${A.reset}.`,
          );
          sent++;
        }
        break;
      }

      if (action === 'edit') {
        const updated = runEditor(db, item);
        item = { ...item, draftSubject: updated.subject, draftBody: updated.body };
        // `continue` re-enters the while loop → re-renders with updated draft
        continue;
      }

      if (action === 'discard') {
        db.prepare(`UPDATE queue_items SET status = 'discarded' WHERE id = ?`).run(item.id);
        console.log(
          `\n  ${A.dim}✗ ${item.profile.company.name} → discarded${A.reset}`,
        );
        discarded++;
        break;
      }

      // skip
      skipped++;
      break;
    }
  }

  console.log(
    `\n[review-outreach] Session complete: ` +
    `${A.bold}${A.green}${sent} sent${A.reset} · ` +
    `${A.dim}${discarded} discarded${A.reset} · ` +
    `${skipped} skipped.`,
  );
}

main().catch((err: unknown) => {
  console.error('[review-outreach] Fatal:', err);
  process.exit(1);
});
