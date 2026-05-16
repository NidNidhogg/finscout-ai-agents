/**
 * Module A — DefiLlama data source ingestion.
 * Fetches live protocol data from DefiLlama (no API key required), filters to ICP,
 * resolves canonical URLs (follows redirects, strips tracking params, drops dead sites),
 * maps to EnrichedProfile, and pushes into the pending review queue.
 *
 * Dedup key: resolved websiteUrl — twitter handle is not required.
 * Safe to run repeatedly; existing URLs are skipped silently.
 *
 * Usage:
 *   npx ts-node src/cli/fetch-defillama.ts
 */

import 'dotenv/config';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { EnrichedProfileSchema } from '../schema/enrichedProfile';
import type { EnrichedProfile } from '../schema/enrichedProfile';
import { resolveCanonicalUrl } from '../utils/urlUtils';

// ── Config ────────────────────────────────────────────────────────────────────

const DB_PATH = process.env['REVIEW_DB_PATH'] ?? 'data/review-queue.db';
const DEFILLAMA_URL = 'https://api.llama.fi/protocols';
const MIN_TVL = 10_000_000;
const MAX_TVL = 100_000_000;
const INSERT_LIMIT = 5;

const TARGET_CATEGORIES = new Set([
  'Bridge',
  'Dexes',
  'Lending',
  'Yield',
  'Liquid Staking',
]);

const CATEGORY_ARCH_TERMS: Record<string, string[]> = {
  Bridge:           ['bridge', 'cross-chain', 'settlement'],
  Dexes:            ['dex', 'amm', 'liquidity'],
  Lending:          ['vault', 'yield', 'liquidation'],
  Yield:            ['yield', 'vault', 'amm'],
  'Liquid Staking': ['restaking', 'validator', 'stablecoin'],
};

// ── DefiLlama response shape (partial) ────────────────────────────────────────

interface DLProtocol {
  name: string;
  tvl: number;
  twitter?: string | null;
  url?: string | null;
  category?: string | null;
  chains?: string[];
}

// ── Handle normaliser ─────────────────────────────────────────────────────────

function normalizeHandle(raw: string): string {
  const match = raw.match(/(?:(?:twitter|x)\.com\/)?@?([A-Za-z0-9_]{1,50})$/);
  return match ? `@${match[1]}` : `@${raw.trim().replace(/^@/, '')}`;
}

// ── Formatters ────────────────────────────────────────────────────────────────

function formatTVL(tvl: number): string {
  if (tvl >= 1_000_000) return `$${(tvl / 1_000_000).toFixed(1)}M`;
  return `$${(tvl / 1_000).toFixed(0)}k`;
}

// ── Profile builder ───────────────────────────────────────────────────────────

function buildProfile(proto: DLProtocol, resolvedUrl: string): EnrichedProfile {
  const now = new Date().toISOString();
  const archTerms = CATEGORY_ARCH_TERMS[proto.category ?? ''] ?? [];

  return EnrichedProfileSchema.parse({
    id: randomUUID(),
    enrichedAt: now,
    schemaVersion: '1.0.0',
    sources: {},
    company: {
      name: proto.name,
      normalizedName: proto.name.toLowerCase().replace(/[\s/]+/g, '-'),
      websiteUrl: resolvedUrl,
      ...(proto.twitter ? { xHandle: normalizeHandle(proto.twitter) } : {}),
    },
    funding: {
      claimed: {
        rawText: `DefiLlama TVL: ${formatTVL(proto.tvl)}`,
      },
    },
    product: {
      selfClaimedCategory: proto.category ?? undefined,
      stackMentions: [],
      architectureTerms: archTerms,
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
  console.log('[fetch-defillama] Fetching protocol list from api.llama.fi…');

  const resp = await fetch(DEFILLAMA_URL);
  if (!resp.ok) {
    console.error(`[fetch-defillama] HTTP ${resp.status} from DefiLlama API`);
    process.exit(1);
  }

  const protocols = (await resp.json()) as DLProtocol[];
  console.log(`[fetch-defillama] ${protocols.length} total protocols received.`);

  // Filter: TVL in range, has a URL, target category — twitter no longer required
  const candidates = protocols
    .filter(
      (p) =>
        typeof p.tvl === 'number' &&
        p.tvl >= MIN_TVL &&
        p.tvl <= MAX_TVL &&
        p.url &&
        p.category &&
        TARGET_CATEGORIES.has(p.category),
    )
    .sort((a, b) => b.tvl - a.tvl);

  console.log(
    `[fetch-defillama] ${candidates.length} candidates after ICP filter ` +
      `(TVL $${MIN_TVL / 1e6}M–$${MAX_TVL / 1e6}M, categories: ${[...TARGET_CATEGORIES].join(', ')}).`,
  );

  if (candidates.length === 0) {
    console.log('[fetch-defillama] No candidates match criteria. Nothing inserted.');
    process.exit(0);
  }

  // Load existing websiteUrls for cross-run dedup
  const db = new Database(DB_PATH);
  const existingUrls = new Set<string>(
    (
      db
        .prepare<[], { url: string | null }>(
          `SELECT json_extract(profile_json, '$.company.websiteUrl') AS url FROM queue_items`,
        )
        .all()
    )
      .map((r) => r.url)
      .filter((u): u is string => Boolean(u)),
  );

  const insertStmt = db.prepare<[string, string, string], void>(
    `INSERT OR IGNORE INTO queue_items (id, profile_json, status, enqueued_at) VALUES (?, ?, 'pending', ?)`,
  );

  const now = new Date().toISOString();
  let inserted = 0;

  console.log(
    `\n  ${'Name'.padEnd(22)} ${'URL'.padEnd(38)} ${'TVL'.padEnd(10)} Category`,
  );
  console.log('  ' + '─'.repeat(82));

  for (const proto of candidates) {
    if (inserted >= INSERT_LIMIT) break;

    process.stdout.write(`  … ${proto.name.padEnd(22)} resolving URL…\r`);

    const resolvedUrl = await resolveCanonicalUrl(proto.url!);

    if (!resolvedUrl) {
      console.log(`  ✗ ${proto.name.padEnd(22)} ${String(proto.url).slice(0, 38).padEnd(38)} dead/unreachable — skipped`);
      continue;
    }

    if (existingUrls.has(resolvedUrl)) {
      // Silent skip for already-queued URLs
      continue;
    }

    let profile: EnrichedProfile;
    try {
      profile = buildProfile(proto, resolvedUrl);
    } catch {
      // Zod url() validation failure on the resolved URL — skip
      continue;
    }

    insertStmt.run(profile.id, JSON.stringify(profile), now);
    existingUrls.add(resolvedUrl);
    inserted++;

    const displayUrl = resolvedUrl.length > 36 ? resolvedUrl.slice(0, 35) + '…' : resolvedUrl;
    const handle = proto.twitter ? ` (${normalizeHandle(proto.twitter)})` : '';
    console.log(
      `  ✓ ${proto.name.padEnd(22)} ${displayUrl.padEnd(38)} ${formatTVL(proto.tvl).padEnd(10)} ${proto.category}${handle}`,
    );
  }

  console.log(`\n[fetch-defillama] ${inserted} protocol(s) inserted into pending queue → ${DB_PATH}`);

  if (inserted < INSERT_LIMIT) {
    console.log(
      `[fetch-defillama] Note: only ${inserted}/${INSERT_LIMIT} slots filled — remaining candidates were dead, unreachable, or already queued.`,
    );
  }
}

main().catch((err: unknown) => {
  console.error('[fetch-defillama] Fatal:', err);
  process.exit(1);
});
