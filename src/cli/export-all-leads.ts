/**
 * export-all-leads — Dual-mode pipeline export.
 *
 * Master export:  exports/real_pipeline.xlsx
 *   Contains every queue_item at every status, all-time.
 *   This is the Single Source of Truth (SSOT) for pipeline state.
 *   Also written to exports/real_pipeline_YYYY-MM-DD.xlsx (versioned snapshot).
 *
 * Delta export:   exports/new_leads_YYYY-MM-DD.xlsx
 *   Contains ONLY rows where enqueued_at OR reviewed_at falls on today's date.
 *   Strictly deduped — old, unchanged records are excluded by construction.
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

const DB_PATH    = process.env['REVIEW_DB_PATH'] ?? 'data/review-queue.db';
const OUT_DIR    = 'exports';
const OUT_MASTER = path.join(OUT_DIR, 'real_pipeline.xlsx');

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

const HEADER_BG  = '1E293B';
const TIER_A_BG  = 'D1FAE5';
const TIER_B_BG  = 'DBEAFE';
const SENT_BG    = 'ECFDF5';
const DISCARD_BG = 'FEE2E2';

function rowFill(tier: string, status: string): ExcelJS.Fill | undefined {
  if (tier   === 'A')         return { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${TIER_A_BG}` } };
  if (tier   === 'B')         return { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${TIER_B_BG}` } };
  if (status === 'sent')      return { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${SENT_BG}` } };
  if (status === 'discarded') return { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${DISCARD_BG}` } };
  return undefined;
}

// ── Source detection ──────────────────────────────────────────────────────────

function detectSource(rawText?: string | null): string {
  if (!rawText)                           return 'unknown';
  if (rawText.startsWith('CryptoRank:'))  return 'cryptorank';
  if (rawText.startsWith('Funding Radar:')) return 'funding-radar';
  if (rawText.startsWith('X-Radar:'))     return 'x-radar';
  if (rawText.startsWith('DefiLlama TVL:')) return 'defillama';
  return 'manual';
}

// ── Delta filter ──────────────────────────────────────────────────────────────

/**
 * A row belongs in the delta if it was enqueued today (net-new lead) OR
 * had its reviewed_at timestamp set today (status updated this run).
 * Old, unchanged records are excluded by construction — no extra dedup needed.
 */
function isDeltaRow(row: QueueRow, today: string): boolean {
  return (
    row.enqueued_at.slice(0, 10) === today ||
    (row.reviewed_at !== null && row.reviewed_at.slice(0, 10) === today)
  );
}

// ── Workbook builder ──────────────────────────────────────────────────────────

function makeWorkbook(label: string): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator          = `FinScout AI Agents — iDECP (${label})`;
  wb.created          = new Date();
  wb.modified         = new Date();
  wb.properties.date1904 = false;
  return wb;
}

/** Populates a worksheet with pipeline rows. Handles header, data, fills, and auto-width. */
function populateWorksheet(
  ws: ExcelJS.Worksheet,
  rows: QueueRow[],
  draftMap: Map<string, AgentRunRow>,
): void {
  ws.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.hint }));

  // Style header row
  const headerRow = ws.getRow(1);
  headerRow.eachCell((cell) => {
    cell.font      = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11, name: 'Calibri' };
    cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${HEADER_BG}` } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: false };
    cell.border    = { bottom: { style: 'medium', color: { argb: 'FF475569' } } };
  });
  headerRow.height = 22;

  const colWidths: number[] = COLUMNS.map((c) => c.header.length);

  rows.forEach((row, idx) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const profile    = parseJSON<any>(row.profile_json) ?? {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const annotation = parseJSON<any>(row.annotation_json) ?? {};
    const draft      = draftMap.get(row.id);

    const company = profile.company         ?? {};
    const funding = profile.funding?.claimed ?? {};
    const product = profile.product         ?? {};

    const tier       = (annotation.tier       as string | undefined) ?? '';
    const tierReason = (annotation.tierReason as string | undefined) ?? '';

    const values: Record<string, string | number> = {
      rowNum:       idx + 1,
      status:       row.status,
      tier,
      tierReason,
      companyName:  (company.name       as string | undefined) ?? '',
      xHandle:      (company.xHandle    as string | undefined) ?? '',
      website:      (company.websiteUrl as string | undefined) ?? '',
      domain:       extractDomain(company.websiteUrl as string | undefined),
      fundingUSD:   formatUSD(funding.amountUSD as number | undefined),
      stage:        ((funding.stage     as string | undefined) ?? '').replace(/_/g, '-'),
      raiseDate:    shortDate(funding.claimedAt as string | undefined),
      source:       detectSource(funding.rawText as string | undefined),
      techStack:    ((product.stackMentions     as string[] | undefined) ?? []).join(', '),
      archTerms:    ((product.architectureTerms as string[] | undefined) ?? []).join(', '),
      draftSubject: draft?.draft_subject ?? '',
      draftBody:    draft?.draft_body    ?? '',
      enqueuedAt:   shortDate(row.enqueued_at),
      reviewedAt:   shortDate(row.reviewed_at),
      profileId:    row.id,
    };

    const dataRow = ws.addRow(values);
    dataRow.height = 16;

    const fill = rowFill(tier, row.status);
    if (fill) dataRow.eachCell((cell) => { cell.fill = fill; });

    const bodyCell = dataRow.getCell('draftBody');
    bodyCell.alignment = { wrapText: true, vertical: 'top' };
    if (draft?.draft_body) dataRow.height = 64;

    COLUMNS.forEach((col, ci) => {
      const val       = String(values[col.key] ?? '');
      const firstLine = val.split('\n')[0] ?? '';
      colWidths[ci]   = Math.max(colWidths[ci] ?? col.hint, firstLine.length);
    });
  });

  // Apply auto-fitted column widths (clamp 10–60)
  ws.columns.forEach((col, ci) => {
    col.width = Math.min(60, Math.max(10, (colWidths[ci] ?? 12) + 2));
  });
}

// ── Tier count helper ─────────────────────────────────────────────────────────

function countTier(rows: QueueRow[], tier: string): number {
  return rows.filter((r) => {
    const a = parseJSON<{ tier?: string }>(r.annotation_json);
    return a?.tier === tier;
  }).length;
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

  // ── Date / path setup ────────────────────────────────────────────────────────

  const _d   = new Date();
  const today = `${_d.getFullYear()}-${String(_d.getMonth() + 1).padStart(2, '0')}-${String(_d.getDate()).padStart(2, '0')}`;

  const OUT_VERSIONED = path.join(OUT_DIR, `real_pipeline_${today}.xlsx`);
  const OUT_DELTA     = path.join(OUT_DIR, `new_leads_${today}.xlsx`);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  // ── Master workbook — all rows, all time ──────────────────────────────────

  const wbMaster = makeWorkbook('master');
  const wsMaster = wbMaster.addWorksheet('Pipeline Leads', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  populateWorksheet(wsMaster, rows, draftMap);

  await wbMaster.xlsx.writeFile(OUT_VERSIONED);
  fs.copyFileSync(OUT_VERSIONED, OUT_MASTER);

  const masterKB = Math.round(fs.statSync(OUT_MASTER).size / 1024);

  // ── Delta workbook — net-new + today-updated rows only ────────────────────

  const deltaRows = rows.filter((r) => isDeltaRow(r, today));

  const wbDelta = makeWorkbook('delta');
  const wsDelta = wbDelta.addWorksheet(`New Leads ${today}`, {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  populateWorksheet(wsDelta, deltaRows, draftMap);

  await wbDelta.xlsx.writeFile(OUT_DELTA);

  const deltaKB = Math.round(fs.statSync(OUT_DELTA).size / 1024);

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log(`[export-all-leads] ── Master ────────────────────────────────────────────`);
  console.log(`[export-all-leads] ✓ ${OUT_VERSIONED}  +  ${OUT_MASTER}  (${masterKB} KB)`);
  console.log(`[export-all-leads]   ${rows.length} rows  |  Tier A: ${countTier(rows, 'A')}  |  Tier B: ${countTier(rows, 'B')}`);
  console.log(`[export-all-leads] ── Delta ─────────────────────────────────────────────`);
  console.log(`[export-all-leads] ✓ ${OUT_DELTA}  (${deltaKB} KB)`);
  console.log(`[export-all-leads]   ${deltaRows.length} rows  |  Tier A: ${countTier(deltaRows, 'A')}  |  Tier B: ${countTier(deltaRows, 'B')}`);
  console.log(`[export-all-leads]   Filter: enqueued_at = ${today}  OR  reviewed_at = ${today}`);
  console.log(`[export-all-leads]   Columns: ${COLUMNS.length}  |  Frozen header: yes  |  Colour-coded: yes`);
}

main().catch((err: unknown) => {
  console.error('[export-all-leads] Fatal:', err);
  process.exit(1);
});
