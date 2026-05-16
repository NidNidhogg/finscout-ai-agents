/**
 * Funding Radar — X (Twitter) announcement ingestion.
 * Searches recent tweets for Web3/DeFi funding announcements ($1M+), resolves the
 * company website URL from the tweet or author profile, maps to EnrichedProfile,
 * and inserts into the pending review queue.
 *
 * Dedup keys: resolved websiteUrl (cross-run) + authorHandle (within-run).
 * Safe to run repeatedly; existing URLs are skipped silently.
 *
 * Usage:
 *   npx ts-node src/cli/fetch-funding.ts
 */

import 'dotenv/config';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { EnrichedProfileSchema } from '../schema/enrichedProfile';
import type { EnrichedProfile, FundingStage } from '../schema/enrichedProfile';
import { resolveCanonicalUrl } from '../utils/urlUtils';
import { ConcreteXApiClient } from '../enrichment/x-signal/ConcreteXApiClient';
import { ConcreteCompanyResolver } from '../enrichment/x-signal/ConcreteCompanyResolver';
import {
  extractFundingAmountUSD,
  isBelowFundingThreshold,
} from '../enrichment/x-signal/filters';

// ── Config ─────────────────────────────────────────────────────────────────────

const DB_PATH = process.env['REVIEW_DB_PATH'] ?? 'data/review-queue.db';
const FUNDING_THRESHOLD_USD = 1_000_000;
const INSERT_LIMIT = 5;
const MAX_RESULTS = 100; // fetch wide; client-side filters trim noise

// Broad query per user spec — catches announcement tweets across all author types.
// First-person filtering is applied client-side to ensure the author IS the company.
// -is:retweet -is:reply keeps only original posts.
const SEARCH_QUERY =
  'raised ("seed" OR "series" OR "strategic" OR "pre-seed") ' +
  '("$1M" OR "$2M" OR "$3M" OR "$4M" OR "$5M" OR "$6M" OR "$7M" OR "$8M" OR "$9M" OR "$10M" OR "million") ' +
  '("protocol" OR "defi" OR "web3" OR "blockchain" OR "crypto") ' +
  '-is:retweet -is:reply lang:en';

// Patterns that signal the tweet AUTHOR is the company making the announcement,
// not a news outlet or third-party reporter.
const FIRST_PERSON_PATTERNS = [
  'we raised', 'we just raised', 'we closed', 'we just closed',
  'we\'re excited', 'we are excited', 'our round', 'our seed', 'our series',
  'thrilled to announce', 'excited to announce', 'proud to announce',
  'just closed our', 'just raised our', 'announcing our',
];

// Domains that signal a news/aggregator account rather than the company itself
const NEWS_DOMAINS = new Set([
  'bsc.news', 'coindesk.com', 'decrypt.co', 'cointelegraph.com',
  'theblock.co', 'blockworks.co', 'cryptoslate.com', 'cryptobriefing.com',
  'beincrypto.com', 'ambcrypto.com', 'newsbtc.com', 'dailyhodl.com',
  'bitcoinmagazine.com', 'coinmarketcap.com', 'coingecko.com',
  'messari.io', 'defiant.io', 'thedefiant.io',
]);

// Domains that are link aggregators / social hubs — not a company website
const AGGREGATOR_DOMAINS = new Set([
  'linktr.ee', 't.me', 'telegram.me', 'mailchi.mp', 'substack.com',
  'medium.com', 'beacons.ai', 'bio.link', 'allmylinks.com', 'carrd.co',
]);

// ── Domain quality guards ──────────────────────────────────────────────────────

function isBlockedDomain(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return NEWS_DOMAINS.has(hostname) || AGGREGATOR_DOMAINS.has(hostname);
  } catch {
    return false;
  }
}

// ── Stage extraction ───────────────────────────────────────────────────────────

function extractStage(text: string): FundingStage {
  const lower = text.toLowerCase();
  if (lower.includes('pre-seed') || lower.includes('preseed') || lower.includes('pre seed')) return 'pre_seed';
  if (lower.includes('series c')) return 'series_c';
  if (lower.includes('series b')) return 'series_b';
  if (lower.includes('series a')) return 'series_a';
  if (lower.includes('seed')) return 'seed';
  if (lower.includes('growth')) return 'growth';
  return 'other';
}

// ── Formatters ─────────────────────────────────────────────────────────────────

function formatUSD(amountUSD: number): string {
  if (amountUSD >= 1_000_000_000) return `$${(amountUSD / 1_000_000_000).toFixed(1)}B`;
  if (amountUSD >= 1_000_000) {
    const m = amountUSD / 1_000_000;
    return `$${m % 1 === 0 ? m : m.toFixed(1)}M`;
  }
  return `$${(amountUSD / 1_000).toFixed(0)}k`;
}

function stageLabel(stage: FundingStage): string {
  const MAP: Record<FundingStage, string> = {
    pre_seed: 'Pre-Seed',
    seed: 'Seed',
    series_a: 'Series A',
    series_b: 'Series B',
    series_c: 'Series C',
    growth: 'Growth',
    other: 'Strategic',
  };
  return MAP[stage];
}

function buildRawText(handle: string, amountUSD: number, stage: FundingStage): string {
  return `X-Radar: ${handle} just announced raising ${formatUSD(amountUSD)} in ${stageLabel(stage)}.`;
}

// ── Profile builder ────────────────────────────────────────────────────────────

function buildProfile(opts: {
  handle: string;
  companyName: string;
  websiteUrl: string;
  amountUSD: number;
  stage: FundingStage;
  tweetId: string;
  tweetText: string;
  postedAt: string;
  authorBio?: string;
}): EnrichedProfile {
  const now = new Date().toISOString();

  return EnrichedProfileSchema.parse({
    id: randomUUID(),
    enrichedAt: now,
    schemaVersion: '1.0.0',
    sources: {},
    company: {
      name: opts.companyName,
      normalizedName: opts.companyName.toLowerCase().replace(/[\s/]+/g, '-'),
      websiteUrl: opts.websiteUrl,
      xHandle: opts.handle,
    },
    funding: {
      claimed: {
        rawText: buildRawText(opts.handle, opts.amountUSD, opts.stage),
        amountUSD: opts.amountUSD,
        stage: opts.stage,
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
    rawContent: {
      websiteMarkdown: {},
      sourceTweets: [
        {
          id: opts.tweetId,
          text: opts.tweetText,
          postedAt: opts.postedAt,
          authorHandle: opts.handle,
          ...(opts.authorBio ? { authorBio: opts.authorBio } : {}),
        },
      ],
    },
  });
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const bearerToken = process.env['X_BEARER_TOKEN'];
  if (!bearerToken) {
    console.error('[fetch-funding] ERROR: X_BEARER_TOKEN is required.');
    process.exit(1);
  }

  const xClient = new ConcreteXApiClient({ bearerToken });
  const resolver = new ConcreteCompanyResolver();

  console.log('[fetch-funding] Searching X for Web3/DeFi funding announcements…');
  console.log(`[fetch-funding] Query: ${SEARCH_QUERY}\n`);

  let tweets;
  try {
    tweets = await xClient.searchRecentTweets({ query: SEARCH_QUERY, maxResults: MAX_RESULTS });
  } catch (err: unknown) {
    console.error('[fetch-funding] X API error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  console.log(`[fetch-funding] ${tweets.length} tweet(s) received from X API.`);

  if (tweets.length === 0) {
    console.log('[fetch-funding] No tweets returned. Nothing inserted.');
    process.exit(0);
  }

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
  let skippedAmount = 0;
  let skippedNoUrl = 0;
  let skippedDup = 0;
  let passedFirstPerson = 0;
  const seenHandles = new Set<string>();

  console.log(
    `\n  ${'Handle'.padEnd(22)} ${'Amount'.padEnd(10)} ${'Stage'.padEnd(12)} URL`,
  );
  console.log('  ' + '─'.repeat(80));

  for (const tweet of tweets) {
    if (inserted >= INSERT_LIMIT) break;

    // Within-run handle dedup (same company may tweet multiple times)
    if (seenHandles.has(tweet.authorHandle)) continue;

    // Client-side quality gate: require first-person language so the tweet author
    // IS the announcing company, not a news account reporting on someone else's raise.
    const lowerText = tweet.text.toLowerCase();
    const isFirstPerson = FIRST_PERSON_PATTERNS.some((p) => lowerText.includes(p));
    if (!isFirstPerson) continue;
    passedFirstPerson++;

    // Filter: drop if amount is explicitly below threshold
    if (isBelowFundingThreshold(tweet.text, FUNDING_THRESHOLD_USD)) {
      skippedAmount++;
      continue;
    }

    const amountUSD = extractFundingAmountUSD(tweet.text);

    // Skip if no parseable amount (can't verify the $1M floor)
    if (amountUSD === null) {
      skippedAmount++;
      continue;
    }

    // Resolve website URL: tweet text → author profile URL
    process.stdout.write(`  … ${tweet.authorHandle.padEnd(22)} resolving URL…\r`);

    const resolved = await resolver.resolve(
      tweet.authorHandle,
      tweet.text,
      tweet.authorProfileUrl,
    );

    if (!resolved?.websiteUrl) {
      console.log(`  ✗ ${tweet.authorHandle.padEnd(22)} no URL found in tweet or profile — skipped`);
      skippedNoUrl++;
      continue;
    }

    const canonicalUrl = await resolveCanonicalUrl(resolved.websiteUrl);

    if (!canonicalUrl) {
      console.log(`  ✗ ${tweet.authorHandle.padEnd(22)} URL unreachable (${resolved.websiteUrl.slice(0, 40)}) — skipped`);
      skippedNoUrl++;
      continue;
    }

    if (isBlockedDomain(canonicalUrl)) {
      console.log(`  ✗ ${tweet.authorHandle.padEnd(22)} news/aggregator domain — skipped`);
      skippedNoUrl++;
      continue;
    }

    if (existingUrls.has(canonicalUrl)) {
      skippedDup++;
      seenHandles.add(tweet.authorHandle);
      continue;
    }

    const stage = extractStage(tweet.text);
    const companyName = resolved.name ?? tweet.authorHandle.replace(/^@/, '');

    let profile: EnrichedProfile;
    try {
      profile = buildProfile({
        handle: tweet.authorHandle,
        companyName,
        websiteUrl: canonicalUrl,
        amountUSD,
        stage,
        tweetId: tweet.id,
        tweetText: tweet.text,
        postedAt: tweet.postedAt,
        authorBio: tweet.authorBio,
      });
    } catch {
      continue;
    }

    insertStmt.run(profile.id, JSON.stringify(profile), now);
    existingUrls.add(canonicalUrl);
    seenHandles.add(tweet.authorHandle);
    inserted++;

    const displayUrl = canonicalUrl.length > 34 ? canonicalUrl.slice(0, 33) + '…' : canonicalUrl;
    console.log(
      `  ✓ ${tweet.authorHandle.padEnd(22)} ${formatUSD(amountUSD).padEnd(10)} ${stageLabel(stage).padEnd(12)} ${displayUrl}`,
    );
  }

  console.log(
    `\n[fetch-funding] ${tweets.length} tweets → ${passedFirstPerson} first-person → ${inserted} inserted → ${DB_PATH}`,
  );
  if (skippedAmount > 0)
    console.log(`[fetch-funding] ${skippedAmount} skipped (amount below $1M or unparseable).`);
  if (skippedNoUrl > 0)
    console.log(`[fetch-funding] ${skippedNoUrl} skipped (no resolvable website URL).`);
  if (skippedDup > 0)
    console.log(`[fetch-funding] ${skippedDup} skipped (already queued).`);
}

main().catch((err: unknown) => {
  console.error('[fetch-funding] Fatal:', err);
  process.exit(1);
});
