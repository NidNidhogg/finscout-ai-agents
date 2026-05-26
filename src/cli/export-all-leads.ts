/**
 * export-all-leads — Full pipeline Excel export.
 *
 * Reads every row in queue_items (all statuses), flattens the nested
 * profile_json / annotation_json into a clean columnar layout, and writes a
 * styled .xlsx workbook at exports/real_pipeline.xlsx.
 *
 * Styling:
 *   • Dark-slate header row with white bold text
 *   • Frozen top row (panes)
 *   • Auto-fitted column widths (min 12, max 60 chars)
 *   • Tier A rows → light green fill
 *   • Tier B rows → light blue fill
 *   • status = 'sent' rows → mint tint
 *   • status = 'discarded' rows → pale red tint
 *
 * Usage:
 *   npm run export
 *
 * Requires: REVIEW_DB_PATH (optional, defaults to data/review-queue.db)
 */

import 'dotenv/config';
import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';

// ── Config ────────────────────────────────────────────────────────────────────

const DB_PATH  = process.env['REVIEW_DB_PATH'] ?? 'data/review-queue.db';
const OUT_DIR  = 'exports';
const OUT_FILE = path.join(OUT_DIR, 'real_pipeline.xlsx');

// ── DB row types ──────────────────────────────────────────────────────────────

interface QueueRow {
  id:              string;
  status:          string;
  enqueued_at:     string;
  reviewed_at:     string | null;
  profile_json:    string;
  annotation_json: string | null;
}

interface AgentRunRow {
  draft_subject: string | null;
  draft_body:    string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseJSON<T>(raw: string | null): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

function extractDomain(url?: string | null): string {
  if (!url) return '';
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function shortDate(iso?: string | null): string {
  if (!iso) return '';
  return iso.slice(0, 10);
}

function formatUSD(amount?: number | null): string {
  if (!amount) return '';
  if (amount >= 1_000_000_000) return `$${(amount / 1_000_000_000).toFixed(1)}B`;
  if (amount >= 1_000_000)     return `$${(amount / 1_000_000).toFixed(0)}M`;
  if (amount >= 1_000)         return `$${(amount / 1_000).toFixed(0)}k`;
  return `$${amount}`;
}

// ── Column definitions ────────────────────────────────────────────────────────

interface ColDef {
  header: string;
  key:    string;
  /** Hint for auto-width (chars). Actual content wins if wider. */
  hint:   number;
}

const COLUMNS: ColDef[] = [
  { header: '#',              key: 'rowNum',         hint: 4  },
  { header: 'Status',         key: 'status',         hint: 12 },
  { header: 'Tier',           key: 'tier',           hint: 6  },
  { header: 'Tier Reason',    key: 'tierReason',     hint: 40 },
  { header: 'Company',        key: 'companyName',    hint: 22 },
  { header: 'X Handle',       key: 'xHandle',        hint: 18 },
  { header: 'Website',        key: 'website',        hint: 28 },
  { header: 'Domain',         key: 'domain',         hint: 22 },
  { header: 'Funding (USD)',  key: 'fundingUSD',     hint: 14 },
  { header: 'Stage',          key: 'stage',          hint: 12 },
  { header: 'Raise Date',     key: 'raiseDate',      hint: 12 },
  { header: 'Source',         key: 'source',         hint: 14 },
  { header: 'Tech Stack',     key: 'techStack',      hint: 30 },
  { header: 'Arch Terms',     key: 'archTerms',      hint: 30 },
  { header: 'Draft Subject',  key: 'draftSubject',   hint: 36 },
  { header: 'Draft Body',     key: 'draftBody',      hint: 60 },
  { header: 'Enqueued',       key: 'enqueuedAt',     hint: 12 },
  { header: 'Reviewed',       key: 'reviewedAt',     hint: 12 },
  { header: 'Profile ID',     key: 'profileId',      hint: 38 },
];

// ── Colour palette ────────────────────────────────────────────────────────────

const HEADER_BG  = '1E293B'; // dark slate
const TIER_A_BG  = 'D1FAE5'; // light green  (Tailwind green-100)
const TIER_B_BG  = 'DBEAFE'; // light blue   (Tailwind blue-100)
const SENT_BG    = 'ECFDF5'; // mint
const DISCARD_BG = 'FEE2E2'; // pale red

function rowFill(tier: string, status: string): ExcelJS.Fill | undefined {
  if (tier    === 'A')          return { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${TIER_A_BG}` } };
  if (tier    === 'B')          return { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${TIER_B_BG}` } };
  if (status  === 'sent')       return { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${SENT_BG}` } };
  if (status  === 'discarded')  return { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${DISCARD_BG}` } };
  return undefined;
}

// ── Detect lead source from rawText ──────────────────────────────────────────

function detectSource(rawText?: string | null): string {
  if (!rawText)                          return 'unknown';
  if (rawText.startsWith('CryptoRank:'))  return 'cryptorank';
  if (rawText.startsWith('Funding Radar:')) return 'funding-radar';
  if (rawText.startsWith('X-Radar:'))    return 'x-radar';
  if (rawText.startsWith('DefiLlama TVL:')) return 'defillama';
  return 'manual';
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const db = new Database(DB_PATH);

  const rows = db
    .prepare<[], QueueRow>(`
      SELECT id, status, enqueued_at, reviewed_at, profile_json, annotation_json
      FROM queue_items
      ORDER BY
        CASE json_extract(annotation_json, '$.tier')
          WHEN 'A' THEN 0
          WHEN 'B' THEN 1
          WHEN 'C' THEN 2
          ELSE 3
        END ASC,
        enqueued_at DESC
    `)
    .all();

  console.log(`[export-all-leads] ${rows.length} rows loaded from queue_items.`);

  // Pre-fetch latest agent draft for every queue item (single query).
  const draftMap = new Map<string, AgentRunRow>();
  const drafts = db
    .prepare<[], { queue_item_id: string; draft_subject: string | null; draft_body: string | null }>(`
      SELECT queue_item_id, draft_subject, draft_body
      FROM agent_runs
      WHERE id IN (
        SELECT id FROM agent_runs ar2
        WHERE ar2.queue_item_id = agent_runs.queue_item_id
        ORDER BY started_at DESC LIMIT 1
      )
    `)
    .all();
  for (const d of drafts) draftMap.set(d.queue_item_id, d);

  db.close();

  // ── Build workbook ──────────────────────────────────────────────────────────

  const wb = new ExcelJS.Workbook();
  wb.creator   = 'FinScout AI Agents — iDECP';
  wb.created   = new Date();
  wb.modified  = new Date();
  wb.properties.date1904 = false;

  const ws = wb.addWorksheet('Pipeline Leads', {
    views: [{ state: 'frozen', ySplit: 1 }],  // freeze header row
  });

  // Set columns
  ws.columns = COLUMNS.map((c) => ({
    header: c.header,
    key:    c.key,
    width:  c.hint,
  }));

  // Style header row
  const headerRow = ws.getRow(1);
  headerRow.eachCell((cell) => {
    cell.font  = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11, name: 'Calibri' };
    cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${HEADER_BG}` } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: false };
    cell.border = {
      bottom: { style: 'medium', color: { argb: 'FF475569' } },
    };
  });
  headerRow.height = 22;

  // ── Track max content widths for auto-fit ────────────────────────────────────
  const colWidths: number[] = COLUMNS.map((c) => c.header.length);

  // ── Add data rows ────────────────────────────────────────────────────────────

  rows.forEach((row, idx) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const profile    = parseJSON<any>(row.profile_json) ?? {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const annotation = parseJSON<any>(row.annotation_json) ?? {};
    const draft      = draftMap.get(row.id);

    const company  = profile.company  ?? {};
    const funding  = profile.funding?.claimed ?? {};
    const product  = profile.product  ?? {};

    const tier       = (annotation.tier        as string | undefined) ?? '';
    const tierReason = (annotation.tierReason  as string | undefined) ?? '';

    const values: Record<string, string | number> = {
      rowNum:       idx + 1,
      status:       row.status,
      tier,
      tierReason,
      companyName:  (company.name    as string | undefined) ?? '',
      xHandle:      (company.xHandle as string | undefined) ?? '',
      website:      (company.websiteUrl as string | undefined) ?? '',
      domain:       extractDomain(company.websiteUrl as string | undefined),
      fundingUSD:   formatUSD(funding.amountUSD as number | undefined),
      stage:        ((funding.stage as string | undefined) ?? '').replace(/_/g, '-'),
      raiseDate:    shortDate(funding.claimedAt as string | undefined),
      source:       detectSource(funding.rawText as string | undefined),
      techStack:    ((product.stackMentions as string[] | undefined) ?? []).join(', '),
      archTerms:    ((product.architectureTerms as string[] | undefined) ?? []).join(', '),
      draftSubject: draft?.draft_subject ?? '',
      draftBody:    draft?.draft_body    ?? '',
      enqueuedAt:   shortDate(row.enqueued_at),
      reviewedAt:   shortDate(row.reviewed_at),
      profileId:    row.id,
    };

    const dataRow = ws.addRow(values);
    dataRow.height = 16;

    // Apply fill
    const fill = rowFill(tier, row.status);
    if (fill) {
      dataRow.eachCell((cell) => { cell.fill = fill; });
    }

    // Style draftBody cell: enable wrapping and cap height for readability
    const bodyCell = dataRow.getCell('draftBody');
    bodyCell.alignment = { wrapText: true, vertical: 'top' };
    if (draft?.draft_body) dataRow.height = 64;

    // Update max column widths
    COLUMNS.forEach((col, ci) => {
      const val = String(values[col.key] ?? '');
      // Measure first line only (wrapping cells can be very tall)
      const firstLine = val.split('\n')[0] ?? '';
      colWidths[ci] = Math.max(colWidths[ci] ?? col.hint, firstLine.length);
    });
  });

  // Apply auto-fitted widths (clamp between 10 and 60)
  ws.columns.forEach((col, ci) => {
    col.width = Math.min(60, Math.max(10, (colWidths[ci] ?? 12) + 2));
  });

  // ── Save ─────────────────────────────────────────────────────────────────────

  fs.mkdirSync(OUT_DIR, { recursive: true });
  await wb.xlsx.writeFile(OUT_FILE);

  const sizeKB = Math.round(fs.statSync(OUT_FILE).size / 1024);
  const tierA  = rows.filter((r) => {
    const a = parseJSON<{ tier?: string }>(r.annotation_json);
    return a?.tier === 'A';
  }).length;
  const tierB  = rows.filter((r) => {
    const a = parseJSON<{ tier?: string }>(r.annotation_json);
    return a?.tier === 'B';
  }).length;

  console.log(`[export-all-leads] ✓ Workbook written → ${OUT_FILE} (${sizeKB} KB)`);
  console.log(`[export-all-leads]   ${rows.length} rows  |  Tier A: ${tierA}  |  Tier B: ${tierB}`);
  console.log(`[export-all-leads]   Columns: ${COLUMNS.length}  |  Frozen header: yes  |  Colour-coded: yes`);
}

main().catch((err: unknown) => {
  console.error('[export-all-leads] Fatal:', err);
  process.exit(1);
});
