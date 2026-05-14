import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { mkdir } from 'fs/promises';
import { dirname } from 'path';
import { createReviewQueue } from '../review-queue/ReviewQueue';
import { EnrichedProfileSchema, ReviewAnnotationSchema } from '../schema/enrichedProfile';
import type { EnrichedProfile, ReviewAnnotation } from '../schema/enrichedProfile';

const DB_PATH = process.env['REVIEW_DB_PATH'] ?? 'data/review-queue.db';
const NOW = new Date().toISOString();
const REVIEWED_BY = 'db@radianceteam.com';

// ── Diamond definitions ───────────────────────────────────────────────────────

interface Diamond {
  name: string;
  normalizedName: string;
  xHandle: string;
  websiteUrl?: string;
  fundingAmountUSD: number;
  fundingStage: 'pre_seed' | 'seed';
  fundingRawText: string;
  architectureTerms: string[];
  tier: 'A';
  note: string;
}

const DIAMONDS: Diamond[] = [
  {
    name: 'Konnex',
    normalizedName: 'konnex',
    xHandle: '@konnex_world',
    fundingAmountUSD: 15_000_000,
    fundingStage: 'seed',
    fundingRawText: '@konnex_world raised $15M from LD Capital and Framework.',
    architectureTerms: ['smart contract', 'multisig', 'settlement'],
    tier: 'A',
    note: 'DeFi Payments, robotic AI smart contracts. Target for smart contract audit and MVA.',
  },
  {
    name: 'Americanfort',
    normalizedName: 'americanfort',
    xHandle: '@Americanfort_io',
    fundingAmountUSD: 8_000_000,
    fundingStage: 'seed',
    fundingRawText: '$8M raised to build the most secure transaction layer in history.',
    architectureTerms: ['key management', 'threshold signature', 'zero knowledge'],
    tier: 'A',
    note: 'Web3 Infrastructure, secure transaction layer. Target for Zero-Trust architecture consulting.',
  },
  {
    name: 'PIN AI',
    normalizedName: 'pin ai',
    xHandle: '@pinai_io',
    websiteUrl: 'https://pinai.io',
    fundingAmountUSD: 10_000_000,
    fundingStage: 'pre_seed',
    fundingRawText: '@pinai_io $10M pre-seed backed by a16z.',
    architectureTerms: ['account abstraction'],
    tier: 'A',
    note: 'Personal AI Network, backed by a16z. High priority.',
  },
];

// ── Builders ──────────────────────────────────────────────────────────────────

function buildProfile(d: Diamond): EnrichedProfile {
  return EnrichedProfileSchema.parse({
    id: randomUUID(),
    enrichedAt: NOW,
    schemaVersion: '1.0.0',
    sources: {
      xApi: {
        lastFetched: NOW,
        tweetsConsidered: 1,
        founderHandle: d.xHandle,
      },
    },
    company: {
      name: d.name,
      normalizedName: d.normalizedName,
      ...(d.websiteUrl ? { websiteUrl: d.websiteUrl } : {}),
      xHandle: d.xHandle,
    },
    funding: {
      claimed: {
        amountUSD: d.fundingAmountUSD,
        stage: d.fundingStage,
        claimedAt: NOW,
        rawText: d.fundingRawText,
      },
    },
    product: {
      stackMentions: [],
      architectureTerms: d.architectureTerms,
      antiSignalTerms: [],
      competencyCellMatches: [],
      evidence: [],
    },
    team: { founders: [] },
    rawContent: { websiteMarkdown: {} },
  });
}

function buildAnnotation(profileId: string, d: Diamond): ReviewAnnotation {
  return ReviewAnnotationSchema.parse({
    profileId,
    reviewedAt: NOW,
    reviewedBy: REVIEWED_BY,
    profileAdequate: true,
    missingEvidenceTypes: [],
    tier: d.tier,
    tierReason: d.note,
    crunchbaseCheck: { checked: false },
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await mkdir(dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  const queue = createReviewQueue({ db });

  console.log('[inject-diamonds] Injecting manually qualified leads...\n');

  for (const diamond of DIAMONDS) {
    const profile = buildProfile(diamond);
    const annotation = buildAnnotation(profile.id, diamond);

    await queue.push(profile);
    await queue.submitReview(profile.id, annotation);

    console.log(`  ✓ ${diamond.name.padEnd(14)} tier:${diamond.tier}  $${(diamond.fundingAmountUSD / 1_000_000).toFixed(0)}M  ${diamond.xHandle}`);
  }

  // Purge all pending items — these are the noise candidates from automated polling
  const purged = db.prepare(`DELETE FROM queue_items WHERE status = 'pending'`).run();
  console.log(`\n[inject-diamonds] Purged ${purged.changes} pending noise items.`);

  const stats = await queue.getStats();
  console.log(`[inject-diamonds] Queue state → reviewed: ${stats.reviewedCount}, dropped: ${stats.droppedCount}, pending: ${stats.pendingCount}`);
}

main().catch((err: unknown) => {
  console.error('[inject-diamonds] Fatal:', err);
  process.exit(1);
});
