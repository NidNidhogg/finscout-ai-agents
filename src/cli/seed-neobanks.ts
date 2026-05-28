/**
 * One-shot seeder — inserts curated Web3/Crypto neobank companies into the
 * review queue as `pending` so enrich-pending.ts can crawl their websites.
 *
 * URLs are hardcoded from verified sources (anti-hallucination policy).
 * Onyx Zephyr has no verifiable standalone URL and is intentionally omitted
 * from the URL dictionary — it will be seeded without a websiteUrl and
 * discarded by enrichment, which is the honest outcome.
 *
 * Usage:
 *   npm run seed:neobanks
 */

import 'dotenv/config';
import { randomUUID } from 'crypto';
import { mkdir } from 'fs/promises';
import { dirname } from 'path';
import Database from 'better-sqlite3';
import { EnrichedProfileSchema } from '../schema/enrichedProfile';
import type { EnrichedProfile } from '../schema/enrichedProfile';
import { createReviewQueue } from '../review-queue/ReviewQueue';

const DB_PATH = process.env['REVIEW_DB_PATH'] ?? 'data/review-queue.db';
const SOURCE_TAG = 'Neobank_Map_2026';

// Verified URLs — do NOT invent or guess. If a URL is unknown, omit the key.
const NEOBANK_URLS: Record<string, string> = {
  'Kast':        'https://www.kast.xyz',
  'Deblock':     'https://deblock.com',
  'Brighty':     'https://brighty.app',
  'Holyheld':    'https://holyheld.com',
  'Keytom':      'https://www.keytom.com',
  'Tria':        'https://www.tria.so',
  'Fuze':        'https://fuze.finance',
  'Bitoasis':    'https://bitoasis.net',
  'Fasset':      'https://www.fasset.com',
  'Belo':        'https://www.belo.app',
  'Lemon':       'https://lemon.me',
  'Bitso':       'https://bitso.com',
  'Ripio':       'https://www.ripio.com',
  'Takenos':     'https://takenos.com',
  'StraitsX':    'https://www.straitsx.com',
  'DTC Pay':     'https://dtcpay.com',
  'XREX':        'https://xrex.io',
  'Wirex':       'https://www.wirexapp.com',
  'Nexo':        'https://nexo.com',
  'Bitpanda':    'https://www.bitpanda.com',
  // 'Onyx Zephyr' — no verified standalone neobank URL found; omitted per anti-hallucination policy
  'Suberra':     'https://suberra.com',
  'Fiat24':      'https://www.fiat24.com',
  'Bitwala':     'https://bitwala.com',
  'Wallbit':     'https://wallbit.io',
  'Nebeus':      'https://nebeus.com',
};

const NEOBANKS: string[] = [
  'Kast', 'Deblock', 'Brighty', 'Holyheld', 'Keytom', 'Tria', 'Fuze',
  'Bitoasis', 'Fasset', 'Belo', 'Lemon', 'Bitso', 'Ripio', 'Takenos',
  'StraitsX', 'DTC Pay', 'XREX', 'Wirex', 'Nexo', 'Bitpanda',
  'Onyx Zephyr', 'Suberra', 'Fiat24', 'Bitwala', 'Wallbit', 'Nebeus',
];

function toNormalizedName(name: string): string {
  return name.toLowerCase().replace(/[\s/]+/g, '-');
}

function buildSeedProfile(name: string, websiteUrl?: string): EnrichedProfile {
  const now = new Date().toISOString();
  return EnrichedProfileSchema.parse({
    id: randomUUID(),
    enrichedAt: now,
    schemaVersion: '1.0.0',
    sources: {},
    company: {
      name,
      normalizedName: toNormalizedName(name),
      ...(websiteUrl ? { websiteUrl } : {}),
    },
    funding: {
      claimed: {
        rawText: `Source: ${SOURCE_TAG}`,
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

async function main(): Promise<void> {
  await mkdir(dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  const queue = createReviewQueue({ db });

  const existingRows = db
    .prepare<[], { normalizedName: string }>(
      `SELECT json_extract(profile_json, '$.company.normalizedName') AS normalizedName
       FROM queue_items`,
    )
    .all();
  const existing = new Set(existingRows.map((r) => r.normalizedName));

  const updateUrl = db.prepare<[string, string]>(
    `UPDATE queue_items
     SET profile_json = json_set(profile_json, '$.company.websiteUrl', ?)
     WHERE json_extract(profile_json, '$.company.normalizedName') = ?`,
  );

  console.log(`[seed-neobanks] ${existing.size} existing entries in queue.\n`);

  let inserted = 0;
  let updated = 0;
  let noUrl = 0;

  for (const name of NEOBANKS) {
    const normalizedName = toNormalizedName(name);
    const websiteUrl = NEOBANK_URLS[name];

    if (existing.has(normalizedName)) {
      if (websiteUrl) {
        updateUrl.run(websiteUrl, normalizedName);
        console.log(`  ↻ updated ${name.padEnd(16)} → websiteUrl: ${websiteUrl}`);
        updated++;
      } else {
        console.log(`  – no-url  ${name.padEnd(16)} (no verified URL; leaving as-is)`);
        noUrl++;
      }
      continue;
    }

    const profile = buildSeedProfile(name, websiteUrl);
    await queue.push(profile);
    console.log(`  + added   ${name.padEnd(16)} → pending  url: ${websiteUrl ?? 'none'}`);
    inserted++;
  }

  const stats = await queue.getStats();
  console.log(
    `\n[seed-neobanks] Done — inserted:${inserted}  updated:${updated}  no-url:${noUrl}` +
    `  queue.pending:${stats.pendingCount}`,
  );
}

main().catch((err: unknown) => {
  console.error('[seed-neobanks] Fatal:', err);
  process.exit(1);
});
