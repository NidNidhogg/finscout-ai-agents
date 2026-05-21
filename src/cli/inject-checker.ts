/**
 * One-shot injector — passes the Checker tweet through the real filter chain,
 * scores it, and inserts it into the DB as 'drafted' with a Tier A annotation
 * and a Baron Sever-style outreach draft in agent_runs.
 *
 * Usage:
 *   npx ts-node src/cli/inject-checker.ts
 */

import 'dotenv/config';
import { randomUUID } from 'crypto';
import { mkdir } from 'fs/promises';
import { dirname } from 'path';
import Database from 'better-sqlite3';
import { EnrichedProfileSchema, ReviewAnnotationSchema } from '../schema/enrichedProfile';
import { createReviewQueue } from '../review-queue/ReviewQueue';
import { scoreProfile } from '../sales-factory/scoreProfile';
import { extractFundingAmountUSD } from '../enrichment/x-signal/filters';

// ── Tweet data (verbatim from user spec) ──────────────────────────────────────

const TWEET_HANDLE = '@checkercorp';
const TWEET_TEXT =
  "We've raised $8.1M to accelerate our mission to secure Web3 infrastructure...";
const TWEET_ID = 'inject-checker-001';

// ── Pipeline ──────────────────────────────────────────────────────────────────

const DB_PATH = process.env['REVIEW_DB_PATH'] ?? 'data/review-queue.db';
const NOW = new Date().toISOString();
const REVIEWED_BY = 'db@radianceteam.com';

// Run the same amount extractor the real pipeline uses
const amountUSD = extractFundingAmountUSD(TWEET_TEXT);
if (!amountUSD) {
  console.error('[inject-checker] extractFundingAmountUSD returned null — check tweet text.');
  process.exit(1);
}
console.log(`[inject-checker] extractFundingAmountUSD → $${(amountUSD / 1_000_000).toFixed(1)}M ✓`);

// Build profile exactly as fetch-funding.ts would
const profileId = randomUUID();

const profile = EnrichedProfileSchema.parse({
  id: profileId,
  enrichedAt: NOW,
  schemaVersion: '1.0.0',
  sources: {
    xApi: {
      lastFetched: NOW,
      tweetsConsidered: 1,
      founderHandle: TWEET_HANDLE,
    },
  },
  company: {
    name: 'Checker',
    normalizedName: 'checker',
    xHandle: TWEET_HANDLE,
  },
  funding: {
    claimed: {
      amountUSD,
      stage: 'seed',
      claimedAt: NOW,
      rawText: `X-Radar: ${TWEET_HANDLE} just announced raising $${(amountUSD / 1_000_000).toFixed(1)}M in Seed.`,
    },
  },
  product: {
    stackMentions: [],
    architectureTerms: ['infrastructure security', 'web3 security layer'],
    antiSignalTerms: [],
    competencyCellMatches: [],
    evidence: [],
  },
  team: { founders: [] },
  rawContent: {
    websiteMarkdown: {},
    sourceTweets: [
      {
        id: TWEET_ID,
        text: TWEET_TEXT,
        postedAt: NOW,
        authorHandle: TWEET_HANDLE,
      },
    ],
  },
});

// Score through the real scoreProfile pipeline
const tierResult = scoreProfile(profile);
console.log(`[inject-checker] scoreProfile → Tier ${tierResult.tier}: ${tierResult.reason}`);

if (tierResult.tier !== 'A') {
  console.error(`[inject-checker] Expected Tier A but got Tier ${tierResult.tier}. Aborting.`);
  process.exit(1);
}
console.log('[inject-checker] Tier A confirmed ✓');

// ReviewAnnotation — mirrors what inject-diamonds.ts produces for diamonds
const annotation = ReviewAnnotationSchema.parse({
  profileId,
  reviewedAt: NOW,
  reviewedBy: REVIEWED_BY,
  profileAdequate: true,
  missingEvidenceTypes: [],
  tier: 'A',
  tierReason:
    'Fresh $8.1M seed raise. "Secure Web3 infrastructure" signals post-raise key-management ' +
    'and auth-path risk. Prime target for MVA / Zero-Trust engagement.',
  crunchbaseCheck: { checked: false },
});

// ── Baron Sever draft (pre-generated, same format as AgentExecutionHarness) ────

const DRAFT_SUBJECT = 'web3 infra auth shortcuts post-raise';

const DRAFT_BODY = `Hey [Founder],
Your $8.1M raise to build a secure Web3 infrastructure layer is the exact stage where key management shortcuts get calcified — the protocol-boundary decisions made in weeks 1–4 that harden into liabilities once TVL crosses $10M. The pattern: informal key custody and synchronous auth paths that survive from MVP into production, compounding into a hard scaling wall at months 8–12. iDECP's MVA engagement (6–12 weeks) closes this gap before it's load-bearing — Zero-Trust primitives at custody boundaries, HSM-grade key rotation, and observability instrumented before the first institutional audit. What's the current approach for cross-chain key custody at the protocol layer?

Baron`;

// ── DB write ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // amountUSD is guaranteed non-null: the module-level guard exits before main() runs.
  // TypeScript does not narrow module-level bindings inside async closures, so we assert here.
  const amount: number = amountUSD!;

  await mkdir(dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  const queue = createReviewQueue({ db }); // creates queue_items table if needed

  // Step 1: push as 'pending'
  await queue.push(profile);

  // Step 2: submitReview sets status → 'reviewed' and writes annotation_json
  await queue.submitReview(profileId, annotation);

  // Step 3: ensure agent_runs schema (identical to AgentExecutionHarness.ensureSchema)
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_runs (
      id              TEXT PRIMARY KEY,
      queue_item_id   TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'running',
      model           TEXT NOT NULL,
      started_at      TEXT NOT NULL,
      completed_at    TEXT,
      iteration_count INTEGER NOT NULL DEFAULT 0,
      history_json    TEXT NOT NULL DEFAULT '[]',
      draft_subject   TEXT,
      draft_body      TEXT,
      error_message   TEXT,
      FOREIGN KEY (queue_item_id) REFERENCES queue_items(id)
    )
  `);

  // Step 4: insert agent_runs with the pre-written draft
  const runId = randomUUID();
  db.prepare(`
    INSERT INTO agent_runs
      (id, queue_item_id, status, model, started_at, completed_at,
       iteration_count, history_json, draft_subject, draft_body)
    VALUES (?, ?, 'completed', 'inject', ?, ?, 0, '[]', ?, ?)
  `).run(runId, profileId, NOW, NOW, DRAFT_SUBJECT, DRAFT_BODY);

  // Step 5: advance status to 'drafted' (same final state as AgentExecutionHarness)
  db.prepare(`UPDATE queue_items SET status = 'drafted' WHERE id = ?`).run(profileId);

  console.log(
    `\n  ✓ ${'Checker'.padEnd(14)} tier:A  ` +
    `$${(amount / 1_000_000).toFixed(1)}M  ${TWEET_HANDLE}  ` +
    `→ status: drafted`,
  );
  console.log(`  ID: ${profileId}`);
}

main().catch((err: unknown) => {
  console.error('[inject-checker] Fatal:', err);
  process.exit(1);
});
