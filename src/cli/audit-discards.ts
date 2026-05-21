/**
 * Discard Audit — observability tool for False Negative detection.
 *
 * Reads all 'discarded' queue items and surfaces:
 *   1. A summary table of discard counts grouped by rejection reason category.
 *   2. The 5 most recently discarded items for manual spot-checking.
 *
 * Usage:
 *   npx ts-node src/cli/audit-discards.ts
 *   REVIEW_DB_PATH=data/other.db npx ts-node src/cli/audit-discards.ts
 */

import 'dotenv/config';
import Database from 'better-sqlite3';
import type { EnrichedProfile, ReviewAnnotation } from '../schema/enrichedProfile';

// ── Config ─────────────────────────────────────────────────────────────────────

const DB_PATH = process.env['REVIEW_DB_PATH'] ?? 'data/review-queue.db';
const RECENT_LIMIT = 5;

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
  magenta: '\x1b[35m',
};

// ── DB row type ────────────────────────────────────────────────────────────────

interface DiscardRow {
  id:              string;
  profile_json:    string;
  annotation_json: string | null;
  enqueued_at:     string;
}

// ── Parsed item ────────────────────────────────────────────────────────────────

interface DiscardedItem {
  id:          string;
  company:     string;
  handle:      string;
  website:     string;
  tier:        string | null;
  reason:      string;
  category:    string;
  enqueuedAt:  string;
}

// ── Reason extraction ──────────────────────────────────────────────────────────

function extractReason(annotationJson: string | null): string {
  if (!annotationJson) return 'Unknown/Unspecified';
  try {
    const a = JSON.parse(annotationJson) as Partial<ReviewAnnotation> & Record<string, unknown>;
    const raw =
      (a['tierReason']      as string | undefined) ??
      (a['tier_reason']     as string | undefined) ??
      (a['scoring_reason']  as string | undefined) ??
      (a['reason']          as string | undefined) ??
      (a['error']           as string | undefined) ??
      null;
    return raw?.trim() || 'Unknown/Unspecified';
  } catch {
    return 'Unknown/Unspecified';
  }
}

// ── Reason categorisation ──────────────────────────────────────────────────────
// Buckets surface-level signal so the summary table stays actionable rather
// than exploding into one bucket per unique reason string.

function categorise(reason: string): string {
  const r = reason.toLowerCase();
  if (r.includes('firecrawl'))                                   return 'Firecrawl failure';
  if (r.includes('timeout') || r.includes('timed out'))         return 'Timeout';
  if (r.includes('below') && r.includes('threshold'))           return 'Below funding threshold';
  if (r.includes('temporal') || r.includes('stale') || r.includes('age'))
                                                                 return 'Stale / temporal gate';
  if (r.includes('no tech') || r.includes('missing tech') || r.includes('no_tech'))
                                                                 return 'No tech signal';
  if (r.includes('anti-signal') || r.includes('antisignal') || r.includes('anti signal'))
                                                                 return 'Anti-signal hit';
  if (r.includes('llm') || r.includes('hallucin'))              return 'LLM rejection';
  if (r.includes('duplicate') || r.includes('already'))         return 'Duplicate';
  if (r.includes('no funding') || r.includes('funding not'))    return 'No funding signal';
  if (r.includes('unknown/unspecified'))                         return 'Unknown/Unspecified';
  return 'Other';
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.slice(0, 16);
  const mm  = String(d.getMonth() + 1).padStart(2, '0');
  const dd  = String(d.getDate()).padStart(2, '0');
  const hh  = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${min}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
function visLen(s: string): number { return s.replace(ANSI_RE, '').length; }
function pad(s: string, w: number): string { return s + ' '.repeat(Math.max(0, w - visLen(s))); }

// ── Summary table ──────────────────────────────────────────────────────────────

function renderSummary(items: DiscardedItem[]): void {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
  }

  // Sort by count DESC, then alpha
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const maxCat = Math.max(...sorted.map(([c]) => c.length), 'Rejection Category'.length);
  const maxCnt = Math.max(...sorted.map(([, n]) => String(n).length), 'Count'.length);
  const barMax = 20;
  const total  = items.length;

  const DIVIDER = `  ${'─'.repeat(maxCat + 2)}┼${'─'.repeat(maxCnt + 2)}┼${'─'.repeat(barMax + 4)}`;

  console.log(`\n${A.bold}  DISCARD SUMMARY  ${A.dim}(${total} total)${A.reset}`);
  console.log();
  console.log(
    `  ${A.bold}${pad('Rejection Category', maxCat)}${A.reset}  ` +
    `${A.bold}${pad('Count', maxCnt)}${A.reset}  ` +
    `${A.bold}Distribution${A.reset}`,
  );
  console.log(DIVIDER);

  for (const [cat, count] of sorted) {
    const bar    = Math.round((count / total) * barMax);
    const filled = `${A.red}${'█'.repeat(bar)}${A.reset}${A.dim}${'░'.repeat(barMax - bar)}${A.reset}`;
    const pct    = `${A.dim}${((count / total) * 100).toFixed(0).padStart(3)}%${A.reset}`;
    console.log(
      `  ${pad(cat, maxCat)}  ` +
      `${A.bold}${A.yellow}${String(count).padStart(maxCnt)}${A.reset}  ` +
      `${filled}  ${pct}`,
    );
  }
}

// ── Recent items list ──────────────────────────────────────────────────────────

function renderRecent(items: DiscardedItem[]): void {
  const recent = items.slice(0, RECENT_LIMIT);

  console.log(`\n${A.bold}  ${RECENT_LIMIT} MOST RECENTLY DISCARDED  ${A.dim}(spot-check for false negatives)${A.reset}`);
  console.log();

  const RULE  = '─'.repeat(66);
  for (let i = 0; i < recent.length; i++) {
    const item = recent[i]!;
    const tierLabel = item.tier
      ? ` ${A.bold}Tier ${item.tier}${A.reset}`
      : ` ${A.dim}untiered${A.reset}`;

    console.log(`  ${A.bold}${i + 1}.  ${item.company}${A.reset}${tierLabel}  ${A.dim}${item.enqueuedAt}${A.reset}`);
    if (item.handle)  console.log(`       ${A.cyan}${item.handle}${A.reset}`);
    if (item.website) console.log(`       ${A.dim}${item.website}${A.reset}`);
    console.log(`       ${A.yellow}Reason:${A.reset} ${truncate(item.reason, 120)}`);
    if (i < recent.length - 1) console.log(`  ${A.dim}${RULE}${A.reset}`);
  }
  console.log();
}

// ── Main ───────────────────────────────────────────────────────────────────────

function main(): void {
  let db: InstanceType<typeof Database>;
  try {
    db = new Database(DB_PATH, { readonly: true });
  } catch {
    console.error(`[audit-discards] Cannot open database at "${DB_PATH}". Does the file exist?`);
    process.exit(1);
  }

  const rows = db
    .prepare<[], DiscardRow>(
      `SELECT id, profile_json, annotation_json, enqueued_at
         FROM queue_items
        WHERE status = 'discarded'
        ORDER BY enqueued_at DESC`,
    )
    .all();

  if (rows.length === 0) {
    console.log('[audit-discards] No discarded items found.');
    return;
  }

  const items: DiscardedItem[] = rows.map((row) => {
    let company = 'Unknown';
    let handle  = '';
    let website = '';
    try {
      const p = JSON.parse(row.profile_json) as Partial<EnrichedProfile>;
      company = p.company?.name       ?? 'Unknown';
      handle  = p.company?.xHandle    ?? '';
      website = p.company?.websiteUrl ?? '';
    } catch { /* malformed — leave defaults */ }

    let tier: string | null = null;
    try {
      if (row.annotation_json) {
        const a = JSON.parse(row.annotation_json) as Partial<ReviewAnnotation>;
        tier = a.tier ?? null;
      }
    } catch { /* ignore */ }

    const reason   = extractReason(row.annotation_json);
    const category = categorise(reason);

    return {
      id: row.id,
      company,
      handle,
      website: website.replace(/^https?:\/\//, '').replace(/\/$/, ''),
      tier,
      reason,
      category,
      enqueuedAt: formatDate(row.enqueued_at),
    };
  });

  console.log(`\n${A.bold}  iDECP — DISCARD AUDIT${A.reset}  ${A.dim}${DB_PATH}${A.reset}`);

  renderSummary(items);
  renderRecent(items);
}

main();
