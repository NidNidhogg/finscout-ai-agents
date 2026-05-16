/**
 * Module A — CryptoRank Funding Radar (Firecrawl scraping).
 * Scrapes https://cryptorank.io/funding-rounds via Firecrawl LLM extraction,
 * filters to ICP (Seed-to-A, ≥$1M, has websiteUrl, within 90-day window),
 * resolves canonical URLs, and inserts into the pending review queue.
 *
 * Usage:
 *   npx ts-node src/cli/fetch-cryptorank.ts
 *
 * Requires: FIRECRAWL_API_KEY, REVIEW_DB_PATH (optional)
 *
 * If Firecrawl returns 0 rounds, the extraction schema or prompt likely needs
 * adjustment due to a CryptoRank layout change — see the EXTRACTION TUNING
 * section below.
 */

import 'dotenv/config';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { EnrichedProfileSchema } from '../schema/enrichedProfile';
import type { EnrichedProfile, FundingStage } from '../schema/enrichedProfile';
import { resolveCanonicalUrl } from '../utils/urlUtils';

// ── Config ────────────────────────────────────────────────────────────────────

const DB_PATH = process.env['REVIEW_DB_PATH'] ?? 'data/review-queue.db';
const FIRECRAWL_BASE = process.env['FIRECRAWL_BASE_URL'] ?? 'https://api.firecrawl.dev';
const CRYPTORANK_URL = 'https://cryptorank.io/funding-rounds';
const MIN_AMOUNT_USD = 1_000_000;
const INSERT_LIMIT = 5;
const DATE_WINDOW_DAYS = 90;

const TARGET_STAGES = new Set([
  'pre-seed', 'preseed',
  'seed',
  'series a', 'series-a',
  'strategic',
]);

// ── Firecrawl types ───────────────────────────────────────────────────────────

// Represents one row as extracted by the LLM from the CryptoRank list page.
interface ScrapedRound {
  name: string;
  website?: string | null;
  amount?: string | null;   // raw string: "$5M", "$500K", "$1.2B"
  stage?: string | null;
  date?: string | null;
  investors?: string[];
}

interface FirecrawlExtractResponse {
  success: boolean;
  data?: {
    extract?: {
      rounds?: ScrapedRound[];
    };
    markdown?: string;      // present only when formats includes "markdown"
  };
  error?: string;
}

// ── EXTRACTION TUNING ─────────────────────────────────────────────────────────
//
// CryptoRank renders funding-rounds via client-side JS. If extraction returns
// 0 rounds, try: increasing waitFor, adjusting the prompt, or checking the page
// structure with formats: ["markdown"] to see raw content.

const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    rounds: {
      type: 'array',
      description: 'All funding rounds visible in the page table or list',
      items: {
        type: 'object',
        properties: {
          name:    { type: 'string', description: 'Project or company name' },
          website: {
            type: 'string',
            description:
              'External project website URL. Do NOT use cryptorank.io URLs. ' +
              'Use null if no external URL is visible.',
          },
          amount:  {
            type: 'string',
            description: 'Amount raised as displayed, e.g. "$5M", "$500K". Null if not shown.',
          },
          stage:   {
            type: 'string',
            description: 'Round type: "Seed", "Pre-Seed", "Series A", "Strategic", etc.',
          },
          date:    {
            type: 'string',
            description: 'Announcement date as displayed, e.g. "Apr 2026". Null if not shown.',
          },
          investors: {
            type: 'array',
            description: 'Investor names. Empty array if none shown.',
            items: { type: 'string' },
          },
        },
        required: ['name'],
      },
    },
  },
  required: ['rounds'],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseAmountUSD(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const match = raw.replace(/,/g, '').match(/\$?([\d.]+)\s*([KkMmBb]?)/);
  if (!match) return null;
  const num = parseFloat(match[1] ?? '0');
  const suffix = (match[2] ?? '').toUpperCase();
  if (suffix === 'K') return Math.round(num * 1_000);
  if (suffix === 'M') return Math.round(num * 1_000_000);
  if (suffix === 'B') return Math.round(num * 1_000_000_000);
  return Math.round(num);
}

function formatAmount(amount: number | null | undefined): string {
  if (!amount) return 'undisclosed';
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}M`;
  return `$${(amount / 1_000).toFixed(0)}k`;
}

function mapStage(raw: string | null | undefined): FundingStage | undefined {
  const key = (raw ?? '').toLowerCase().trim();
  if (key === 'pre-seed' || key === 'preseed') return 'pre_seed';
  if (key === 'seed') return 'seed';
  if (key === 'series a' || key === 'series-a') return 'series_a';
  if (key === 'strategic') return 'other';
  return undefined;
}

function formatInvestors(investors?: string[]): string {
  if (!investors || investors.length === 0) return 'undisclosed';
  return investors.slice(0, 4).join(', ');
}

function isWithinDateWindow(dateStr: string | null | undefined, days: number): boolean {
  if (!dateStr) return true; // unknown date is treated as in-window
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return new Date(dateStr).getTime() >= cutoff;
}

function toISO(dateStr: string | null | undefined): string | undefined {
  if (!dateStr) return undefined;
  try {
    return new Date(dateStr).toISOString();
  } catch {
    return undefined;
  }
}

// ── Firecrawl scrape ──────────────────────────────────────────────────────────

async function scrapeRounds(apiKey: string): Promise<ScrapedRound[]> {
  console.log(`[fetch-cryptorank] Scraping ${CRYPTORANK_URL} via Firecrawl (LLM extract)…`);

  const resp = await fetch(`${FIRECRAWL_BASE}/v1/scrape`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url: CRYPTORANK_URL,
      formats: ['extract'],
      waitFor: 4_000,           // CryptoRank renders table via client-side JS
      extract: {
        prompt:
          'Extract every funding round shown in the table or list on this page. ' +
          'For each round capture: project name, external website URL (skip any ' +
          'cryptorank.io links), amount raised, round stage, date, and investors.',
        schema: EXTRACT_SCHEMA,
      },
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Firecrawl HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }

  const json = (await resp.json()) as FirecrawlExtractResponse;

  if (!json.success) {
    throw new Error(`Firecrawl scrape failed: ${json.error ?? 'unknown error'}`);
  }

  const rounds = json.data?.extract?.rounds;

  if (!rounds || rounds.length === 0) {
    throw new Error(
      'Firecrawl returned 0 rounds from CryptoRank. Possible causes:\n' +
        '  1. CryptoRank page layout changed — inspect the page and update EXTRACT_SCHEMA.\n' +
        '  2. JS rendering incomplete — increase waitFor beyond 4000ms.\n' +
        '  3. Anti-bot blocking active — try a different Firecrawl plan or proxy.\n' +
        '  Diagnostic: re-run with formats: ["markdown"] to inspect raw page content.',
    );
  }

  console.log(`[fetch-cryptorank] Extracted ${rounds.length} round(s) from the page.\n`);
  return rounds;
}

// ── Profile builder ───────────────────────────────────────────────────────────

function buildProfile(
  round: ScrapedRound,
  resolvedUrl: string,
  amountUSD: number | null,
): EnrichedProfile {
  const now = new Date().toISOString();
  const stage = mapStage(round.stage);
  const rawText = `CryptoRank: Raised ${formatAmount(amountUSD)} ${round.stage ?? ''} from ${formatInvestors(round.investors)}`
    .replace(/\s{2,}/g, ' ')
    .trim();

  return EnrichedProfileSchema.parse({
    id: randomUUID(),
    enrichedAt: now,
    schemaVersion: '1.0.0',
    sources: {},
    company: {
      name: round.name,
      normalizedName: round.name.toLowerCase().replace(/[\s/]+/g, '-'),
      websiteUrl: resolvedUrl,
    },
    funding: {
      claimed: {
        rawText,
        ...(amountUSD ? { amountUSD } : {}),
        ...(stage ? { stage } : {}),
        ...(toISO(round.date) ? { claimedAt: toISO(round.date) } : {}),
      },
    },
    product: {
      stackMentions: [],
      architectureTerms: [],
      antiSignalTerms: [],
      competencyCellMatches: [],
      evidence: [],
    },
    team: { founders: [] },
    rawContent: { websiteMarkdown: {} },
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const apiKey = process.env['FIRECRAWL_API_KEY'];
  if (!apiKey) {
    console.error('[fetch-cryptorank] ERROR: FIRECRAWL_API_KEY is required.');
    process.exit(1);
  }

  const cutoffDate = new Date(Date.now() - DATE_WINDOW_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  console.log('[fetch-cryptorank] Funding Radar — CryptoRank scrape via Firecrawl');
  console.log(
    `[fetch-cryptorank] ICP: ≥$${MIN_AMOUNT_USD / 1e6}M · Pre-Seed/Seed/Series A/Strategic · websiteUrl required · date >${cutoffDate}\n`,
  );

  const scraped = await scrapeRounds(apiKey);

  // Parse amounts and apply ICP filters
  const candidates = scraped.map((round) => ({
    round,
    amountUSD: parseAmountUSD(round.amount),
  }));

  const filtered = candidates.filter(({ round, amountUSD }) => {
    if (!round.website) return false;
    const stage = (round.stage ?? '').toLowerCase().trim();
    if (!TARGET_STAGES.has(stage)) return false;
    if (amountUSD !== null && amountUSD < MIN_AMOUNT_USD) return false;
    if (!isWithinDateWindow(round.date, DATE_WINDOW_DAYS)) return false;
    return true;
  });

  const dropped = candidates.length - filtered.length;
  const noUrl = candidates.filter(({ round }) => !round.website).length;
  const wrongStage = candidates.filter(({ round }) => {
    const s = (round.stage ?? '').toLowerCase().trim();
    return round.website && !TARGET_STAGES.has(s);
  }).length;

  console.log(
    `[fetch-cryptorank] ${filtered.length}/${scraped.length} pass ICP filters ` +
      `(dropped: ${noUrl} no website URL, ${wrongStage} wrong stage, ` +
      `${dropped - noUrl - wrongStage} amount/date).\n`,
  );

  if (filtered.length === 0) {
    console.log('[fetch-cryptorank] No candidates match ICP criteria. Nothing inserted.');
    return;
  }

  // Cross-run dedup: load all websiteUrls already in the queue
  const db = new Database(DB_PATH);
  const existingUrls = new Set<string>(
    db
      .prepare<[], { url: string | null }>(
        `SELECT json_extract(profile_json, '$.company.websiteUrl') AS url FROM queue_items`,
      )
      .all()
      .map((r) => r.url)
      .filter((u): u is string => Boolean(u)),
  );

  const insertStmt = db.prepare<[string, string, string], void>(
    `INSERT OR IGNORE INTO queue_items (id, profile_json, status, enqueued_at) VALUES (?, ?, 'pending', ?)`,
  );

  const now = new Date().toISOString();
  let inserted = 0;
  let skippedDedup = 0;
  let skippedDead = 0;
  let skippedSchema = 0;

  console.log(`  ${'Name'.padEnd(26)} ${'URL'.padEnd(36)} ${'Amount'.padEnd(10)} Stage`);
  console.log('  ' + '─'.repeat(84));

  for (const { round, amountUSD } of filtered) {
    if (inserted >= INSERT_LIMIT) break;

    process.stdout.write(`  … ${round.name.padEnd(26)} resolving URL…\r`);

    const resolvedUrl = await resolveCanonicalUrl(round.website!);

    if (!resolvedUrl) {
      console.log(`  ✗ ${round.name.padEnd(26)} dead/unreachable — skipped`);
      skippedDead++;
      continue;
    }

    if (existingUrls.has(resolvedUrl)) {
      skippedDedup++;
      continue;
    }

    let profile: EnrichedProfile;
    try {
      profile = buildProfile(round, resolvedUrl, amountUSD);
    } catch {
      skippedSchema++;
      continue;
    }

    insertStmt.run(profile.id, JSON.stringify(profile), now);
    existingUrls.add(resolvedUrl);
    inserted++;

    const displayUrl =
      resolvedUrl.length > 34 ? resolvedUrl.slice(0, 33) + '…' : resolvedUrl;
    console.log(
      `  ✓ ${round.name.padEnd(26)} ${displayUrl.padEnd(36)} ${formatAmount(amountUSD).padEnd(10)} ${round.stage ?? '—'}`,
    );
  }

  console.log(`
[fetch-cryptorank] Complete.
  Inserted:         ${inserted} → pending queue (${DB_PATH})
  Skipped (dedup):  ${skippedDedup}
  Skipped (dead):   ${skippedDead}
  Skipped (schema): ${skippedSchema}
  Filtered (ICP):   ${dropped}`);

  if (filtered.length > INSERT_LIMIT && inserted === INSERT_LIMIT) {
    console.log(
      `[fetch-cryptorank] INSERT_LIMIT=${INSERT_LIMIT} reached. Increase to process more per run.`,
    );
  }
}

main().catch((err: unknown) => {
  console.error('[fetch-cryptorank] Fatal:', err);
  process.exit(1);
});
