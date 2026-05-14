import { readFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import Database from 'better-sqlite3';
import { resolveFingerprint } from '../fingerprint/resolveFingerprint';
import { ConcreteXApiClient } from '../enrichment/x-signal/ConcreteXApiClient';
import { ConcreteCompanyResolver } from '../enrichment/x-signal/ConcreteCompanyResolver';
import { createXSignalSource } from '../enrichment/x-signal/XSignalSource';
import { FirecrawlFetcher } from '../enrichment/website/FirecrawlFetcher';
import {
  createWebsiteEnricher,
  createProfileComposer,
  createEnrichmentEngine,
} from '../enrichment/EnrichmentEngine';
import { createReviewQueue } from '../review-queue/ReviewQueue';
import type { CompetencyCell } from '../schema/enrichedProfile';
import type { Signal } from '../fingerprint/schemas';

const ALL_CELLS: CompetencyCell[] = [
  'DeFi & Yield',
  'Trading',
  'Infrastructure',
  'Security',
  'Payment Rails',
];

export interface EnrichmentCliConfig {
  bearerToken: string;
  firecrawlApiKey: string;
  searchQuery: string;
  dbPath: string;
  fingerprintsBasePath?: string;
}

export async function runEnrichment(config: EnrichmentCliConfig): Promise<void> {
  const basePath = config.fingerprintsBasePath ?? 'data/fingerprints';

  // Load all cell fingerprints (merged core + cell signals)
  const fingerprints = await Promise.all(
    ALL_CELLS.map((cell) => resolveFingerprint(cell, basePath)),
  );

  // Load raw core signals for the ProfileComposer's core-term lookup
  const coreRaw = await readFile(join(basePath, 'core-web3-signals.json'), 'utf-8');
  const coreData = JSON.parse(coreRaw) as { primarySignals: Signal[] };
  const coreSignals: Signal[] = coreData.primarySignals;

  // Concrete adapters
  const xClient = new ConcreteXApiClient({ bearerToken: config.bearerToken });
  const resolver = new ConcreteCompanyResolver();

  const xSignalSource = createXSignalSource({
    xClient,
    resolver,
    fingerprints,
    config: { searchQuery: config.searchQuery, maxResults: 100 },
  });

  const pageFetcher = new FirecrawlFetcher({ apiKey: config.firecrawlApiKey });
  const websiteEnricher = createWebsiteEnricher({ pageFetcher });
  const profileComposer = createProfileComposer(coreSignals);

  const engine = createEnrichmentEngine({
    xSignalSource,
    websiteEnricher,
    profileComposer,
    fingerprints,
  });

  // Storage
  await mkdir(dirname(config.dbPath), { recursive: true });
  const db = new Database(config.dbPath);
  const queue = createReviewQueue({ db });

  // Run
  console.log(`[run-enrichment] Polling X for: "${config.searchQuery}"`);
  const result = await engine.run();

  console.log(`[run-enrichment] Status: ${result.status}`);

  if (result.status === 'rate_limited') {
    const waitSec = result.retryAfterMs ? Math.ceil(result.retryAfterMs / 1000) : 'unknown';
    console.log(`[run-enrichment] Rate limited — retry after ${waitSec}s`);
    return;
  }

  console.log(`[run-enrichment] Enriched: ${result.profilesEnriched.length} profiles`);
  console.log(`[run-enrichment] Failed:   ${result.failedCandidates.length} candidates`);

  for (const profile of result.profilesEnriched) {
    await queue.push(profile);
    console.log(`[run-enrichment]   + Queued: ${profile.company.name} (${profile.id})`);
  }

  for (const { candidate, error } of result.failedCandidates) {
    console.error(
      `[run-enrichment]   ! Failed: ${candidate.resolvedCompany.websiteUrl}`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function main(): Promise<void> {
  const bearerToken = process.env['X_BEARER_TOKEN'];
  const firecrawlApiKey = process.env['FIRECRAWL_API_KEY'];

  if (!bearerToken) {
    console.error('[run-enrichment] ERROR: X_BEARER_TOKEN environment variable is required.');
    process.exit(1);
  }
  if (!firecrawlApiKey) {
    console.error('[run-enrichment] ERROR: FIRECRAWL_API_KEY environment variable is required.');
    process.exit(1);
  }

  await runEnrichment({
    bearerToken,
    firecrawlApiKey,
    searchQuery:
      process.env['X_SEARCH_QUERY'] ??
      '(raised OR "seed round" OR "pre-seed" OR "series a" OR "in funding" OR "funding round") (web3 OR defi OR crypto OR blockchain) -is:retweet lang:en',
    dbPath: process.env['REVIEW_DB_PATH'] ?? 'data/review-queue.db',
  });
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error('[run-enrichment] Fatal error:', err);
    process.exit(1);
  });
}
