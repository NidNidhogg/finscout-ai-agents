/**
 * Module A — Pending queue enrichment pass.
 * Selects all `pending` queue items, runs Firecrawl deep-crawl on those with a
 * websiteUrl, merges extracted signals into profile_json, generates a system
 * ReviewAnnotation, and flips status to `reviewed`.
 *
 * No X API calls. No external ingestion. Strictly processes the local DB queue.
 *
 * Usage:
 *   npx ts-node src/cli/enrich-pending.ts
 *
 * Requires: FIRECRAWL_API_KEY, REVIEW_DB_PATH (optional)
 */

import 'dotenv/config';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { FirecrawlFetcher } from '../enrichment/website/FirecrawlFetcher';
import { createWebsiteEnricher, WebsiteEnrichmentError } from '../enrichment/EnrichmentEngine';
import { EnrichedProfileSchema, ReviewAnnotationSchema } from '../schema/enrichedProfile';
import type { EnrichedProfile, ReviewAnnotation } from '../schema/enrichedProfile';

// ── Config ────────────────────────────────────────────────────────────────────

const DB_PATH = process.env['REVIEW_DB_PATH'] ?? 'data/review-queue.db';
const SYSTEM_REVIEWER = 'system:enrich-pending';

// ── Types ─────────────────────────────────────────────────────────────────────

interface QueueRow {
  id: string;
  profile_json: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function hasSubstantiveSignals(profile: EnrichedProfile): boolean {
  return (
    profile.product.stackMentions.length > 0 ||
    profile.product.architectureTerms.length > 0
  );
}

function buildAutoAnnotation(
  profileId: string,
  profile: EnrichedProfile,
  crawled: boolean,
  crawlFailed: boolean,
): ReviewAnnotation {
  const now = new Date().toISOString();
  const hasStack = profile.product.stackMentions.length > 0;
  const hasArch = profile.product.architectureTerms.length > 0;
  const hasWebsite = Boolean(profile.company.websiteUrl);

  const missingEvidenceTypes: string[] = [];
  if (!hasStack) missingEvidenceTypes.push('missing_tech_stack');

  const adequate = missingEvidenceTypes.length === 0;

  const tierReasonParts: string[] = [];
  if (crawled) tierReasonParts.push('Firecrawl deep-crawl completed');
  else if (crawlFailed) tierReasonParts.push('Firecrawl failed — signals from source metadata only');
  else if (!hasWebsite) tierReasonParts.push('No websiteUrl — source metadata signals only');
  else tierReasonParts.push('Previously crawled — signals carried forward');

  if (hasStack) tierReasonParts.push(`stack: ${profile.product.stackMentions.slice(0, 3).join(', ')}`);
  if (hasArch) tierReasonParts.push(`arch: ${profile.product.architectureTerms.slice(0, 3).join(', ')}`);

  return ReviewAnnotationSchema.parse({
    profileId,
    reviewedAt: now,
    reviewedBy: SYSTEM_REVIEWER,
    profileAdequate: adequate,
    missingEvidenceTypes,
    tier: adequate ? 'B' : 'C',
    tierReason: [
      ...tierReasonParts,
      ...(hasArch ? [`arch: ${profile.product.architectureTerms.slice(0, 3).join(', ')}`] : []),
    ].join(' · ') || 'Auto-enriched',
    crunchbaseCheck: { checked: false },
  });
}

function mergeEnrichment(
  profile: EnrichedProfile,
  enrichData: Awaited<ReturnType<ReturnType<typeof createWebsiteEnricher>['enrich']>>,
): EnrichedProfile {
  const maxFetchedAt = enrichData.pagesFetched.reduce(
    (max, p) => (p.fetchedAt > max ? p.fetchedAt : max),
    new Date(0),
  );

  return EnrichedProfileSchema.parse({
    ...profile,
    sources: {
      ...profile.sources,
      websiteCrawl: {
        lastFetched: maxFetchedAt.toISOString(),
        pagesCrawled: enrichData.pagesFetched.map((p) => p.url),
        fetcher: 'firecrawl',
      },
    },
    product: {
      ...profile.product,
      stackMentions: enrichData.extractedProduct.stackMentions,
      architectureTerms: [
        ...new Set([
          ...profile.product.architectureTerms,
          ...enrichData.extractedProduct.architectureTerms,
        ]),
      ],
    },
    rawContent: {
      ...profile.rawContent,
      websiteMarkdown: enrichData.websiteMarkdown,
    },
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const firecrawlApiKey = process.env['FIRECRAWL_API_KEY'];
  if (!firecrawlApiKey) {
    console.error('[enrich-pending] ERROR: FIRECRAWL_API_KEY is required.');
    process.exit(1);
  }

  const db = new Database(DB_PATH);
  const rows = db
    .prepare<[], QueueRow>(`SELECT id, profile_json FROM queue_items WHERE status = 'pending'`)
    .all();

  if (rows.length === 0) {
    console.log('[enrich-pending] No pending items found. Queue is empty.');
    process.exit(0);
  }

  console.log(`[enrich-pending] ${rows.length} pending item(s) to process.\n`);

  const pageFetcher = new FirecrawlFetcher({ apiKey: firecrawlApiKey });
  const websiteEnricher = createWebsiteEnricher({ pageFetcher });

  const reviewStmt = db.prepare<[string, string, string, string], void>(
    `UPDATE queue_items
     SET profile_json = ?, status = 'reviewed', reviewed_at = ?, annotation_json = ?
     WHERE id = ?`,
  );

  const discardStmt = db.prepare<[string, string, string], void>(
    `UPDATE queue_items
     SET profile_json = ?, status = 'discarded', reviewed_at = ?
     WHERE id = ?`,
  );

  let enriched = 0;
  let skippedCrawl = 0;
  let crawlFailed = 0;
  let reviewed = 0;
  let discarded = 0;

  for (const row of rows) {
    const profile = EnrichedProfileSchema.parse(JSON.parse(row.profile_json));
    const { name, xHandle, websiteUrl } = profile.company;
    const label = `${name} (${xHandle ?? row.id.slice(0, 8)})`;

    process.stdout.write(`  → ${label.padEnd(36)}`);

    let finalProfile = profile;
    let crawled = false;
    let thisCrawlFailed = false;

    if (!websiteUrl) {
      process.stdout.write('no websiteUrl — skipping crawl\n');
      skippedCrawl++;
    } else if (profile.sources.websiteCrawl?.lastFetched) {
      process.stdout.write(`previously crawled (${profile.sources.websiteCrawl.lastFetched.slice(0, 10)}) — carrying forward\n`);
      skippedCrawl++;
    } else {
      try {
        const enrichData = await websiteEnricher.enrich(websiteUrl);
        finalProfile = mergeEnrichment(profile, enrichData);
        crawled = true;

        const stack = finalProfile.product.stackMentions.join(', ') || '—';
        const arch = finalProfile.product.architectureTerms.slice(0, 4).join(', ') || '—';
        process.stdout.write(`crawled ${enrichData.pagesFetched.length} page(s)\n`);
        console.log(`    stack: ${stack}`);
        console.log(`    arch:  ${arch}`);
        enriched++;
      } catch (err) {
        const msg = err instanceof WebsiteEnrichmentError ? err.message : String(err);
        process.stdout.write(`crawl failed: ${msg}\n`);
        thisCrawlFailed = true;
        crawlFailed++;
      }
    }

    const now = new Date().toISOString();

    // Circuit breaker: discard profiles with no extractable technical signals
    if (!hasSubstantiveSignals(finalProfile)) {
      discardStmt.run(JSON.stringify(finalProfile), now, row.id);
      console.log(`    ⚡ no technical signals → discarded`);
      discarded++;
      continue;
    }

    const annotation = buildAutoAnnotation(row.id, finalProfile, crawled, thisCrawlFailed);
    reviewStmt.run(JSON.stringify(finalProfile), now, JSON.stringify(annotation), row.id);
    reviewed++;
  }

  console.log(`
[enrich-pending] Done.
  Crawled:       ${enriched}
  Skipped crawl: ${skippedCrawl}
  Crawl errors:  ${crawlFailed}
  → reviewed:    ${reviewed}
  → discarded:   ${discarded} (circuit breaker: no technical signals)`);
}

main().catch((err: unknown) => {
  console.error('[enrich-pending] Fatal:', err);
  process.exit(1);
});
