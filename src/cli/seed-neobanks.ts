/**
 * One-shot seeder — inserts curated Web3/Crypto neobank companies into the
 * review queue as `pending` so enrich-pending.ts can discover their handles
 * and website URLs without hallucination.
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

const NEOBANKS: string[] = [
  'Kast', 'Deblock', 'Brighty', 'Holyheld', 'Keytom', 'Tria', 'Fuze',
  'Bitoasis', 'Fasset', 'Belo', 'Lemon', 'Bitso', 'Ripio', 'Takenos',
  'StraitsX', 'DTC Pay', 'XREX', 'Wirex', 'Nexo', 'Bitpanda',
  'Onyx Zephyr', 'Suberra', 'Fiat24', 'Bitwala', 'Wallbit', 'Nebeus',
];

function toNormalizedName(name: string): string {
  return name.toLowerCase().replace(/[\s/]+/g, '-');
}

function buildSeedProfile(name: string): EnrichedProfile {
  const now = new Date().toISOString();
  return EnrichedProfileSchema.parse({
    id: randomUUID(),
    enrichedAt: now,
    schemaVersion: '1.0.0',
    sources: {},
    company: {
      name,
      normalizedName: toNormalizedName(name),
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

  // Build the set of normalizedNames already present in the DB (any status)
  const existingRows = db
    .prepare<[], { normalizedName: string }>(
      `SELECT json_extract(profile_json, '$.company.normalizedName') AS normalizedName
       FROM queue_items`,
    )
    .all();
  const existing = new Set(existingRows.map((r) => r.normalizedName));

  console.log(`[seed-neobanks] ${existing.size} existing entries in queue.\n`);

  let inserted = 0;
  let skipped = 0;

  for (const name of NEOBANKS) {
    const normalizedName = toNormalizedName(name);
    if (existing.has(normalizedName)) {
      console.log(`  – skip  ${name.padEnd(16)} (already in queue as "${normalizedName}")`);
      skipped++;
      continue;
    }

    const profile = buildSeedProfile(name);
    await queue.push(profile);
    console.log(`  + added ${name.padEnd(16)} → pending  id:${profile.id}`);
    inserted++;
  }

  const stats = await queue.getStats();
  console.log(
    `\n[seed-neobanks] Done — inserted:${inserted}  skipped:${skipped}` +
    `  queue.pending:${stats.pendingCount}`,
  );
}

main().catch((err: unknown) => {
  console.error('[seed-neobanks] Fatal:', err);
  process.exit(1);
});
