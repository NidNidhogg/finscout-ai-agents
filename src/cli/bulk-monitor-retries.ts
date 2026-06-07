/**
 * bulk-monitor-retries — Push-based crawl recovery via Firecrawl /monitor.
 *
 * Reads the dated pipeline Excel snapshot, identifies rows that failed the
 * pull-based crawl (status = "needs_retry" or status = "reviewed" with an
 * empty outreach draft), and registers each target URL with the Firecrawl
 * monitor webhook endpoint so future page changes are pushed rather than
 * polled.
 *
 * Usage:
 *   npx ts-node src/cli/bulk-monitor-retries.ts [--dry-run] [path/to/file.xlsx]
 *
 *   --dry-run   Send exactly one request (first URL) to validate the API
 *               handshake, then exit. Does not process remaining rows.
 *
 * Requires: FIRECRAWL_API_KEY in .env
 * Optional: MONITOR_WEBHOOK_URL, FIRECRAWL_MONITOR_ENDPOINT in .env
 *
 * NOTE: As of 2026-06-04 the /v1/monitor route returns HTTP 404 ("Cannot POST
 * /v1/monitor") — this is a server-side route-not-found, not an auth or
 * payload error. Set FIRECRAWL_MONITOR_ENDPOINT in .env to override the path
 * once the correct endpoint is confirmed in Firecrawl's docs/changelog.
 */

import 'dotenv/config';
import path from 'path';
import ExcelJS from 'exceljs';

// ── Flags ─────────────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes('--dry-run');
const positionalArgs = process.argv.slice(2).filter((a) => !a.startsWith('--'));

// ── Config ────────────────────────────────────────────────────────────────────

const XLSX_PATH = positionalArgs[0]
  ?? path.join('exports', 'real_pipeline_2026-06-04.xlsx');

const FIRECRAWL_API_KEY = process.env['FIRECRAWL_API_KEY'] ?? '';
const WEBHOOK_URL       = process.env['MONITOR_WEBHOOK_URL'] ?? 'YOUR_WEBHOOK_URL';
// Override via env once the correct path is confirmed in Firecrawl docs.
const MONITOR_ENDPOINT  =
  process.env['FIRECRAWL_MONITOR_ENDPOINT'] ?? 'https://api.firecrawl.dev/v1/monitor';
const DELAY_MS          = 500;

const MONITOR_PROMPT =
  'Track this page for new job openings. Notify ONLY if new positions ' +
  "containing the keywords 'Rust', 'Solidity', 'Web3', 'Smart Contract', " +
  "or 'Engineer' are added.";

// ── Types ─────────────────────────────────────────────────────────────────────

interface MonitorPayload {
  url:     string;
  prompt:  string;
  webhook: string;
}

interface MonitorResult {
  url:        string;
  success:    boolean;
  error?:     string;
  /** True when the failure is a route-not-found (affects all URLs, not just this one). */
  structural: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Express route-not-found responses contain "Cannot <METHOD> <path>".
 * This is a server-side structural error — retrying other URLs will not help.
 */
function isRouteNotFound(body: string): boolean {
  return /Cannot (POST|GET|PUT|PATCH|DELETE) /.test(body);
}

async function registerMonitor(url: string): Promise<MonitorResult> {
  const payload: MonitorPayload = { url, prompt: MONITOR_PROMPT, webhook: WEBHOOK_URL };

  try {
    const res = await fetch(MONITOR_ENDPOINT, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${FIRECRAWL_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text();
      const structural = res.status === 404 && isRouteNotFound(body);
      return {
        url,
        success: false,
        structural,
        error: `HTTP ${res.status}: ${body.slice(0, 300)}`,
      };
    }

    return { url, success: true, structural: false };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { url, success: false, structural: false, error: message };
  }
}

// ── Excel reader ──────────────────────────────────────────────────────────────

interface PipelineRow {
  status:      string;
  website:     string;
  draftBody:   string;
}

async function loadRetryRows(xlsxPath: string): Promise<PipelineRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxPath);

  const ws = wb.getWorksheet(1);
  if (!ws) throw new Error(`No worksheet found in ${xlsxPath}`);

  // Resolve column indices from the header row (row 1).
  const headerRow = ws.getRow(1);
  const colIndex: Record<string, number> = {};
  headerRow.eachCell((cell, colNumber) => {
    const text = String(cell.value ?? '').trim();
    if (text) colIndex[text] = colNumber;
  });

  const statusCol    = colIndex['Status'];
  const websiteCol   = colIndex['Website'];
  const draftBodyCol = colIndex['Draft Body'];

  if (!statusCol || !websiteCol) {
    throw new Error(
      `Missing required columns. Found: ${Object.keys(colIndex).join(', ')}`
    );
  }

  const rows: PipelineRow[] = [];

  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // skip header

    const status    = String(row.getCell(statusCol).value    ?? '').trim();
    const website   = String(row.getCell(websiteCol).value   ?? '').trim();
    const draftBody = draftBodyCol
      ? String(row.getCell(draftBodyCol).value ?? '').trim()
      : '';

    if (!website) return;

    const isNeedsRetry   = status === 'needs_retry';
    const isCrawlFailure = status === 'reviewed' && draftBody === '';

    if (isNeedsRetry || isCrawlFailure) {
      rows.push({ status, website, draftBody });
    }
  });

  return rows;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!FIRECRAWL_API_KEY) {
    console.error('[bulk-monitor-retries] FIRECRAWL_API_KEY is not set in .env. Aborting.');
    process.exit(1);
  }

  if (DRY_RUN) {
    console.log('[bulk-monitor-retries] ── DRY RUN MODE — one request only ──');
  }

  console.log(`[bulk-monitor-retries] Reading ${XLSX_PATH}`);
  const retryRows = await loadRetryRows(XLSX_PATH);

  if (retryRows.length === 0) {
    console.log('[bulk-monitor-retries] No needs_retry or draft-empty rows found. Nothing to register.');
    return;
  }

  const needsRetryCount   = retryRows.filter((r) => r.status === 'needs_retry').length;
  const crawlFailureCount = retryRows.filter((r) => r.status === 'reviewed').length;

  const targetRows = DRY_RUN ? retryRows.slice(0, 1) : retryRows;

  console.log(
    `[bulk-monitor-retries] Found ${retryRows.length} rows ` +
    `(needs_retry: ${needsRetryCount}, reviewed/no-draft: ${crawlFailureCount})`
  );
  if (DRY_RUN) {
    console.log(`[bulk-monitor-retries] Dry run: testing handshake against 1 of ${retryRows.length} URLs`);
  }
  console.log(`[bulk-monitor-retries] Endpoint:       ${MONITOR_ENDPOINT}`);
  console.log(`[bulk-monitor-retries] Webhook target: ${WEBHOOK_URL}`);
  console.log(`[bulk-monitor-retries] Sending ${targetRows.length} request(s) with ${DELAY_MS}ms delay…\n`);

  const results: MonitorResult[] = [];

  for (let i = 0; i < targetRows.length; i++) {
    const row = targetRows[i]!;
    process.stdout.write(`  [${i + 1}/${targetRows.length}] ${row.website} … `);

    const result = await registerMonitor(row.website);
    results.push(result);

    if (result.success) {
      console.log('✓ registered');
    } else {
      console.log(`✗ FAILED — ${result.error}`);

      // Structural failures (route not found) mean every subsequent request
      // will fail identically. Halt immediately rather than burning rate-limit
      // quota and delay time on guaranteed failures.
      if (result.structural) {
        console.error(
          '\n[bulk-monitor-retries] ── STRUCTURAL ERROR — halting early ──\n' +
          `  The endpoint returned a route-not-found response (HTTP 404 "Cannot POST …").\n` +
          `  This means FIRECRAWL_MONITOR_ENDPOINT=${MONITOR_ENDPOINT} does not exist\n` +
          `  on Firecrawl's API. Remaining ${targetRows.length - i - 1} URL(s) were skipped.\n\n` +
          `  Action required:\n` +
          `    1. Check Firecrawl's changelog/docs for the correct monitor endpoint path.\n` +
          `    2. Set FIRECRAWL_MONITOR_ENDPOINT=<correct-url> in .env and re-run.\n` +
          `    3. Use --dry-run to validate the handshake before processing all rows.`
        );
        process.exit(2);
      }
    }

    if (i < targetRows.length - 1) {
      await delay(DELAY_MS);
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────────

  const succeeded = results.filter((r) => r.success).length;
  const failed    = results.filter((r) => !r.success).length;

  console.log('\n[bulk-monitor-retries] ─────────────────────────────');

  if (DRY_RUN) {
    console.log(`[bulk-monitor-retries] Dry run complete. Result: ${succeeded === 1 ? '✓ handshake OK' : '✗ handshake FAILED'}`);
    if (succeeded === 1) {
      console.log(`[bulk-monitor-retries] Re-run without --dry-run to register all ${retryRows.length} URLs.`);
    }
  } else {
    console.log(`[bulk-monitor-retries] Done. Registered: ${succeeded}  Failed: ${failed}`);
  }

  if (failed > 0 && !DRY_RUN) {
    console.log('\n[bulk-monitor-retries] Failed URLs:');
    results
      .filter((r) => !r.success)
      .forEach((r) => console.log(`  • ${r.url}  →  ${r.error}`));
  }

  if (failed > 0) process.exit(1);
}

main().catch((err: unknown) => {
  console.error('[bulk-monitor-retries] Fatal:', err);
  process.exit(1);
});
