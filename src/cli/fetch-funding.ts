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
import { TRUSTED_CRYPTO_VCS } from '../config/trusted-vcs';

// ── Config ─────────────────────────────────────────────────────────────────────

const DB_PATH = process.env['REVIEW_DB_PATH'] ?? 'data/review-queue.db';
const FUNDING_THRESHOLD_USD = 1_000_000;
const INSERT_LIMIT = 5;
const MAX_RESULTS = 100; // fetch wide; client-side filters trim noise

// Web3/DeFi-scoped query — domain keywords enforce the niche; stage/amount terms
// are intentionally absent to avoid false negatives when founders omit round names.
// Client-side filters (first-person, amount threshold, trusted-VC) handle quality.
const SEARCH_QUERY =
  '("raised" OR "funding" OR "investing in") ' +
  '("web3" OR "crypto" OR "defi" OR "stablecoin" OR "stablecoins" OR "yield" OR "blockchain" OR "protocol") ' +
  '-is:retweet -is:reply lang:en';

// Patterns that signal the tweet AUTHOR is the company making the announcement,
// not a news outlet or third-party reporter.
const FIRST_PERSON_PATTERNS = [
  'we raised', "we've raised", 'we have raised',
  'we just raised', 'we closed', 'we just closed',
  "we're excited", 'we are excited', 'our round', 'our seed', 'our series',
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
  'linktr.ee', 'linkin.bio', 't.me', 'telegram.me', 'mailchi.mp', 'substack.com',
  'medium.com', 'beacons.ai', 'bio.link', 'allmylinks.com', 'carrd.co',
]);

// Subset of AGGREGATOR_DOMAINS where we attempt to extract the real URL before giving up
const UNPACKABLE_AGGREGATOR_DOMAINS = new Set(['linktr.ee', 'linkin.bio', 't.me']);

// Social/platform hostnames to ignore when scanning aggregator pages for the real URL
const SOCIAL_DOMAINS = new Set([
  'twitter.com', 'x.com', 'facebook.com', 'instagram.com', 'linkedin.com',
  'youtube.com', 'discord.com', 'discord.gg', 't.me', 'telegram.me',
  'github.com', 'tiktok.com',
]);

// ── Trusted-VC matching ────────────────────────────────────────────────────────

// Strip all non-alphanumeric chars so "@dragonfly_xyz", "dragonfly xyz", and
// "dragonfly" all normalise to "dragonflyxyz" and match the "dragonfly" entry.
function normStr(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Returns true if the tweet author (handle or bio) matches a trusted institutional VC.
function isAuthorTrustedVC(handle: string, bio?: string): boolean {
  const normHandle = normStr(handle.replace(/^@/, ''));
  const normBio = normStr(bio ?? '');
  return TRUSTED_CRYPTO_VCS.some((vc) => {
    const normVC = normStr(vc);
    return normHandle.includes(normVC) || normBio.includes(normVC);
  });
}

// Returns the first matching trusted-VC name found after "led by" or "backed by"
// in the tweet text, or null if no match.
function findLedByVC(text: string): string | null {
  const lower = text.toLowerCase();
  const phraseMatch = /(?:led|backed)\s+by\s+([\s\S]{1,120}?)(?=[.!?\n]|$)/i.exec(lower);
  if (!phraseMatch) return null;
  const afterPhrase = phraseMatch[1];
  return TRUSTED_CRYPTO_VCS.find((vc) => afterPhrase.includes(vc)) ?? null;
}

// ── Domain quality guards ──────────────────────────────────────────────────────

function isUnpackableDomain(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return UNPACKABLE_AGGREGATOR_DOMAINS.has(hostname);
  } catch {
    return false;
  }
}

// Fetches a link-aggregator page and returns the first real company URL found,
// scanning all https:// URLs in the raw HTML (covers <a href>, JSON data blobs, etc.).
// Returns null if the page is unreachable or no qualifying URL is found.
async function unpackAggregatorUrl(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(5_000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FinScout/1.0)' },
    });
    if (!response.ok) return null;
    const html = await response.text();
    const urlRe = /https?:\/\/[^\s"'<>\\]+/g;
    let match: RegExpExecArray | null;
    while ((match = urlRe.exec(html)) !== null) {
      const candidate = match[0].replace(/[.,;)]+$/, '');
      try {
        const hostname = new URL(candidate).hostname.replace(/^www\./, '');
        if (AGGREGATOR_DOMAINS.has(hostname)) continue;
        if (UNPACKABLE_AGGREGATOR_DOMAINS.has(hostname)) continue;
        if (SOCIAL_DOMAINS.has(hostname)) continue;
        return candidate;
      } catch {
        continue;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function isBlockedDomain(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return NEWS_DOMAINS.has(hostname) || AGGREGATOR_DOMAINS.has(hostname);
  } catch {
    return false;
  }
}

// ── Pain hypothesis inference ──────────────────────────────────────────────────

// Ordered by specificity: more specific terms are checked first.
// Returns the first matching hypothesis, or a safe default.
const PAIN_KEYWORD_MAP: Array<{ keywords: string[]; hypothesis: string }> = [
  {
    keywords: ['zk', 'zero-knowledge', 'zero knowledge', 'zkp', 'zk-snark', 'zk-stark', 'zkevm'],
    hypothesis: 'proving time latency and state verification',
  },
  {
    keywords: ['layer 2', 'l2', 'rollup', 'optimistic', 'arbitrum', 'optimism', 'sequencer'],
    hypothesis: 'L2 finality and sequencer reliability',
  },
  {
    keywords: ['bridge', 'cross-chain', 'interoperab', 'multichain', 'omnichain'],
    hypothesis: 'cross-chain settlement latency',
  },
  {
    keywords: ['stablecoin', 'stablecoins', 'payment rail', 'payments', 'remittance', 'fiat'],
    hypothesis: 'payment rail settlement finality',
  },
  {
    keywords: ['lend', 'borrow', 'collateral', 'liquidat', 'money market'],
    hypothesis: 'liquidation execution reliability',
  },
  {
    keywords: ['dex', 'amm', 'swap', 'order book', 'mev', 'orderbook'],
    hypothesis: 'MEV exposure / order routing',
  },
  {
    keywords: ['nft', 'gaming', 'game', 'metaverse', 'marketplace'],
    hypothesis: 'on-chain transaction throughput and gas predictability',
  },
  {
    keywords: ['staking', 'validator', 'restaking', 'liquid staking', 'slashing'],
    hypothesis: 'validator key management and slashing risk',
  },
];
const DEFAULT_FUNDING_PAIN_HYPOTHESIS = 'on-chain execution reliability';

function inferPainHypothesis(tweetText: string): string {
  const lower = tweetText.toLowerCase();
  for (const { keywords, hypothesis } of PAIN_KEYWORD_MAP) {
    if (keywords.some((kw) => lower.includes(kw))) {
      return hypothesis;
    }
  }
  return DEFAULT_FUNDING_PAIN_HYPOTHESIS;
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
  painHypothesis: string;
}): EnrichedProfile {
  const now = new Date().toISOString();

  return EnrichedProfileSchema.parse({
    id: randomUUID(),
    enrichedAt: now,
    schemaVersion: '1.0.0',
    painHypothesis: opts.painHypothesis,
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
        claimedAt: opts.postedAt,
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

    const lowerText = tweet.text.toLowerCase();

    // Rule A — Brand Bypass: explicit first-person announcement language.
    const isFirstPerson = FIRST_PERSON_PATTERNS.some((p) => lowerText.includes(p));

    // Rule B — VC Author Bypass: "investing in" only when the author is a verified VC.
    const isAuthorVC = isAuthorTrustedVC(tweet.authorHandle, tweet.authorBio);
    const isInvestingIn = isAuthorVC && lowerText.includes('investing in');

    // Rule C — "led by / backed by" a trusted VC in the tweet text.
    const ledByVC = findLedByVC(tweet.text);

    const isVCBypass = isInvestingIn || ledByVC !== null;

    let vcPortfolioName: string | null = null;
    if (isInvestingIn) {
      // Extract portfolio name from "investing in <Company>"
      const vcMatch =
        /investing\s+in\s+(?:@)?([A-Za-z][\w\s.-]{1,40}?)(?=\s+for\b|\s+(?:a|the)\s|\s+with\b|\s*[,!.#@]|\s+(?:seed|series|round|funding|raise)\b|$)/i.exec(
          tweet.text,
        );
      vcPortfolioName = vcMatch?.[1]?.trim() ?? null;
    } else if (ledByVC !== null && !isFirstPerson) {
      // Reporter-style tweet — extract company name from start: "Catena raises $X backed by …"
      const companyMatch =
        /^([A-Z][^.!?\n]{2,50}?)(?=\s+(?:raises|raised|closes|closed|secures|secured|announces|announced|completes|completed)\b)/i.exec(
          tweet.text,
        );
      vcPortfolioName = companyMatch?.[1]?.trim() ?? null;
    }

    if (!isFirstPerson && !isVCBypass) continue;
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

    // Attempt to unpack link-aggregator URLs (linktr.ee, linkin.bio, t.me) before dropping.
    let finalUrl = canonicalUrl;
    if (isUnpackableDomain(canonicalUrl)) {
      process.stdout.write(`  … ${tweet.authorHandle.padEnd(22)} unpacking ${canonicalUrl.slice(0, 30)}…\r`);
      const unpacked = await unpackAggregatorUrl(canonicalUrl);
      if (!unpacked) {
        console.log(`  ✗ ${tweet.authorHandle.padEnd(22)} aggregator unpack failed — skipped`);
        skippedNoUrl++;
        continue;
      }
      const unpackedCanonical = await resolveCanonicalUrl(unpacked);
      if (!unpackedCanonical) {
        console.log(`  ✗ ${tweet.authorHandle.padEnd(22)} unpacked URL unreachable — skipped`);
        skippedNoUrl++;
        continue;
      }
      finalUrl = unpackedCanonical;
    }

    if (isBlockedDomain(finalUrl)) {
      console.log(`  ✗ ${tweet.authorHandle.padEnd(22)} news/aggregator domain — skipped`);
      skippedNoUrl++;
      continue;
    }

    if (existingUrls.has(finalUrl)) {
      skippedDup++;
      seenHandles.add(tweet.authorHandle);
      continue;
    }

    const stage = extractStage(tweet.text);
    const companyName =
      (isVCBypass && vcPortfolioName) ? vcPortfolioName
      : resolved.name ?? tweet.authorHandle.replace(/^@/, '');

    let profile: EnrichedProfile;
    try {
      profile = buildProfile({
        handle: tweet.authorHandle,
        companyName,
        websiteUrl: finalUrl,
        amountUSD,
        stage,
        tweetId: tweet.id,
        tweetText: tweet.text,
        postedAt: tweet.postedAt,
        authorBio: tweet.authorBio,
        painHypothesis: inferPainHypothesis(tweet.text),
      });
    } catch {
      continue;
    }

    insertStmt.run(profile.id, JSON.stringify(profile), now);
    existingUrls.add(finalUrl);
    seenHandles.add(tweet.authorHandle);
    inserted++;

    const displayUrl = finalUrl.length > 34 ? finalUrl.slice(0, 33) + '…' : finalUrl;
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
