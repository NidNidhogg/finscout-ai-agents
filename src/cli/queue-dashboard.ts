/**
 * Queue Dashboard — eagle-eye view of the full sales pipeline.
 *
 * Reads every row in queue_items, formats them into a padded ASCII table with
 * ANSI-coloured Status and Tier columns, and prints active items first followed
 * by a dimmed section for dropped/discarded entries.
 *
 * Usage:
 *   npx ts-node src/cli/queue-dashboard.ts
 *   REVIEW_DB_PATH=data/other.db npx ts-node src/cli/queue-dashboard.ts
 */

import 'dotenv/config';
import Database from 'better-sqlite3';
import type { EnrichedProfile } from '../schema/enrichedProfile';
import type { ReviewAnnotation } from '../schema/enrichedProfile';

// ── Config ─────────────────────────────────────────────────────────────────────

const DB_PATH = process.env['REVIEW_DB_PATH'] ?? 'data/review-queue.db';

// Statuses treated as "inactive" — rendered in a separate dimmed section.
const INACTIVE_STATUSES = new Set(['dropped', 'discarded']);

// ── ANSI ───────────────────────────────────────────────────────────────────────

const A = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  magenta: '\x1b[35m',
  cyan:    '\x1b[36m',
  white:   '\x1b[37m',
  bgRed:   '\x1b[41m',
};

function tierColor(tier: string | null): string {
  if (tier === 'A') return `${A.bold}${A.red}A${A.reset}`;
  if (tier === 'B') return `${A.bold}${A.yellow}B${A.reset}`;
  if (tier === 'C') return `${A.bold}${A.white}C${A.reset}`;
  return `${A.dim}—${A.reset}`;
}

function statusColor(status: string): string {
  switch (status) {
    case 'pending':   return `${A.cyan}pending${A.reset}`;
    case 'reviewed':  return `${A.green}reviewed${A.reset}`;
    case 'drafted':   return `${A.magenta}drafted${A.reset}`;
    case 'sent':      return `${A.bold}${A.green}sent${A.reset}`;
    case 'dropped':   return `${A.dim}dropped${A.reset}`;
    case 'discarded': return `${A.dim}discarded${A.reset}`;
    default:          return `${A.dim}${status}${A.reset}`;
  }
}

// ── DB row type ────────────────────────────────────────────────────────────────

interface QueueRow {
  id:              string;
  profile_json:    string;
  status:          string;
  enqueued_at:     string;
  annotation_json: string | null;
}

// ── Parsed display row ─────────────────────────────────────────────────────────

interface DisplayRow {
  company:   string;
  website:   string;
  tier:      string | null;
  status:    string;
  enqueuedAt: string;
  inactive:  boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.slice(0, 16);
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const dd   = String(d.getDate()).padStart(2, '0');
  const hh   = String(d.getHours()).padStart(2, '0');
  const min  = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${min}`;
}

function parseRow(row: QueueRow): DisplayRow {
  let company = 'Unknown';
  let website = '';
  try {
    const p = JSON.parse(row.profile_json) as Partial<EnrichedProfile>;
    company = p.company?.name ?? 'Unknown';
    website = p.company?.websiteUrl ?? '';
  } catch { /* malformed json — leave defaults */ }

  let tier: string | null = null;
  try {
    if (row.annotation_json) {
      const a = JSON.parse(row.annotation_json) as Partial<ReviewAnnotation>;
      tier = a.tier ?? null;
    }
  } catch { /* annotation unreadable */ }

  return {
    company,
    website:   website.replace(/^https?:\/\//, '').replace(/\/$/, ''),
    tier,
    status:    row.status,
    enqueuedAt: formatDate(row.enqueued_at),
    inactive:  INACTIVE_STATUSES.has(row.status),
  };
}

// Strip ANSI codes to measure printable column width.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function visLen(s: string): number {
  return s.replace(ANSI_RE, '').length;
}

function pad(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - visLen(s)));
}

// ── Table renderer ─────────────────────────────────────────────────────────────

interface ColDef {
  header: string;
  key:    keyof DisplayRow;
  maxWidth?: number;
}

const COLUMNS: ColDef[] = [
  { header: 'Company',  key: 'company',    maxWidth: 30 },
  { header: 'Website',  key: 'website',    maxWidth: 36 },
  { header: 'Tier',     key: 'tier',       maxWidth: 4  },
  { header: 'Status',   key: 'status',     maxWidth: 10 },
  { header: 'Enqueued', key: 'enqueuedAt', maxWidth: 11 },
];

function renderTable(rows: DisplayRow[], dimmed: boolean): void {
  if (rows.length === 0) return;

  // Compute column widths from actual data (header vs content, capped at maxWidth).
  const widths: number[] = COLUMNS.map((col) => {
    const dataMax = rows.reduce((max, r) => {
      const raw = String(r[col.key] ?? '');
      return Math.max(max, raw.length);
    }, 0);
    return Math.min(col.maxWidth ?? 999, Math.max(col.header.length, dataMax));
  });

  const SEP   = dimmed ? `${A.dim}│${A.reset}` : '│';
  const DASH  = dimmed ? `${A.dim}─${A.reset}` : '─';
  const JOIN  = dimmed ? `${A.dim}┼${A.reset}` : '┼';

  const headerCells = COLUMNS.map((col, i) =>
    pad(`${dimmed ? A.dim : A.bold}${col.header}${A.reset}`, widths[i] + (dimmed ? 0 : col.header.length > col.header.length ? 0 : 0)),
  );

  // Build divider line.
  const divLine = COLUMNS.map((_, i) => DASH.repeat(widths[i] + 2)).join(JOIN);

  // Header.
  console.log(' ' + SEP + ' ' + COLUMNS.map((col, i) =>
    pad(`${dimmed ? A.dim : A.bold}${col.header}${A.reset}`, widths[i]),
  ).join(` ${SEP} `) + ` ${SEP}`);
  console.log(` ${divLine}`);
  void headerCells; // referenced above inline

  for (const row of rows) {
    const cells = COLUMNS.map((col, i) => {
      const raw = String(row[col.key] ?? '');
      const truncated = raw.length > widths[i] ? raw.slice(0, widths[i] - 1) + '…' : raw;

      // Apply colour to Tier and Status columns; others plain (or dimmed for inactive rows).
      let cell: string;
      if (col.key === 'tier') {
        cell = pad(tierColor(row.tier), widths[i]);
      } else if (col.key === 'status') {
        cell = pad(statusColor(row.status), widths[i]);
      } else if (dimmed) {
        cell = pad(`${A.dim}${truncated}${A.reset}`, widths[i]);
      } else {
        cell = pad(truncated, widths[i]);
      }
      return cell;
    });

    console.log(` ${SEP} ${cells.join(` ${SEP} `)} ${SEP}`);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

function main(): void {
  let db: InstanceType<typeof Database>;
  try {
    db = new Database(DB_PATH, { readonly: true });
  } catch {
    console.error(`[queue-dashboard] Cannot open database at "${DB_PATH}". Does the file exist?`);
    process.exit(1);
  }

  const rows = db
    .prepare<[], QueueRow>(
      `SELECT id, profile_json, status, enqueued_at, annotation_json
       FROM queue_items
       ORDER BY enqueued_at DESC`,
    )
    .all();

  if (rows.length === 0) {
    console.log('[queue-dashboard] Queue is empty.');
    return;
  }

  const parsed = rows.map(parseRow);
  const active   = parsed.filter((r) => !r.inactive);
  const inactive = parsed.filter((r) =>  r.inactive);

  const totalActive   = active.length;
  const totalInactive = inactive.length;

  // ── Header banner ──────────────────────────────────────────────────────────
  const tierCounts = { A: 0, B: 0, C: 0 };
  for (const r of active) {
    if (r.tier === 'A') tierCounts.A++;
    else if (r.tier === 'B') tierCounts.B++;
    else if (r.tier === 'C') tierCounts.C++;
  }

  const pendingCount  = parsed.filter((r) => r.status === 'pending').length;
  const reviewedCount = parsed.filter((r) => r.status === 'reviewed').length;
  const draftedCount  = parsed.filter((r) => r.status === 'drafted').length;
  const sentCount     = parsed.filter((r) => r.status === 'sent').length;

  console.log();
  console.log(`${A.bold}  SALES PIPELINE DASHBOARD${A.reset}  ${A.dim}${DB_PATH}${A.reset}`);
  console.log(
    `  ${A.cyan}pending ${pendingCount}${A.reset}` +
    `  ${A.green}reviewed ${reviewedCount}${A.reset}` +
    `  ${A.magenta}drafted ${draftedCount}${A.reset}` +
    `  ${A.bold}${A.green}sent ${sentCount}${A.reset}` +
    `  ${A.dim}dropped/discarded ${totalInactive}${A.reset}`,
  );
  console.log(
    `  Tiers — ` +
    `${A.bold}${A.red}A: ${tierCounts.A}${A.reset}  ` +
    `${A.bold}${A.yellow}B: ${tierCounts.B}${A.reset}  ` +
    `${A.bold}${A.white}C: ${tierCounts.C}${A.reset}`,
  );
  console.log();

  // ── Active table ───────────────────────────────────────────────────────────
  if (totalActive > 0) {
    renderTable(active, false);
    console.log();
  }

  // ── Inactive section ───────────────────────────────────────────────────────
  if (totalInactive > 0) {
    console.log(`  ${A.dim}── dropped / discarded (${totalInactive}) ──${A.reset}`);
    console.log();
    renderTable(inactive, true);
    console.log();
  }
}

main();
