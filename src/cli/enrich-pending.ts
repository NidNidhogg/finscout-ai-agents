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
import { scoreProfile } from '../sales-factory/scoreProfile';
import type { IcpTier } from '../sales-factory/scoreProfile';

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
  tier: Exclude<IcpTier, 'C'>,
  scoredReason: string,
): ReviewAnnotation {
  const now = new Date().toISOString();
  const hasStack = profile.product.stackMentions.length > 0;
  const hasArch = profile.product.architectureTerms.length > 0;
  const hasWebsite = Boolean(profile.company.websiteUrl);

  const missingEvidenceTypes: string[] = [];
  if (!hasStack) missingEvidenceTypes.push('missing_tech_stack');

  const adequate = missingEvidenceTypes.length === 0;

  const tierReasonParts: string[] = [scoredReason];
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
    tier,
    tierReason: tierReasonParts.join(' · ') || 'Auto-enriched',
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
    .prepare<[], QueueRow>(`SELECT id, profile_json FROM queue_items WHERE status IN ('pending', 'needs_retry')`)
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

  // Soft-fail: network/scraping errors go to quarantine, not permanent discard.
  const retryStmt = db.prepare<[string, string, string, string], void>(
    `UPDATE queue_items
     SET profile_json = ?, status = 'needs_retry', reviewed_at = ?, annotation_json = ?
     WHERE id = ?`,
  );

  let enriched = 0;
  let skippedCrawl = 0;
  let crawlFailed = 0;
  let reviewed = 0;
  let discarded = 0;
  let retried = 0;

  for (const row of rows) {
    const profile = EnrichedProfileSchema.parse(JSON.parse(row.profile_json));
    const { name, xHandle, websiteUrl } = profile.company;
    const label = `${name} (${xHandle ?? row.id.slice(0, 8)})`;

    process.stdout.write(`  → ${label.padEnd(36)}`);

    let finalProfile = profile;
    let crawled = false;
    let thisCrawlFailed = false;
    let crawlErrorMsg = '';

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
        crawlErrorMsg = err instanceof WebsiteEnrichmentError ? err.message : String(err);
        process.stdout.write(`crawl failed: ${crawlErrorMsg}\n`);
        thisCrawlFailed = true;
        crawlFailed++;
      }
    }

    const now = new Date().toISOString();

    // Circuit breaker: no extractable technical signals.
    // If the crawl failed (network/scraping error), quarantine for retry rather
    // than permanently discarding — the missing signals may be a crawl artifact.
    if (!hasSubstantiveSignals(finalProfile)) {
      if (thisCrawlFailed) {
        const errorAnnotation = JSON.stringify({ error: `Firecrawl failed — no signals extractable: ${crawlErrorMsg}` });
        retryStmt.run(JSON.stringify(finalProfile), now, errorAnnotation, row.id);
        console.log(`    ⏳ crawl failed + no signals → needs_retry`);
        retried++;
      } else {
        discardStmt.run(JSON.stringify(finalProfile), now, row.id);
        console.log(`    ⚡ no technical signals → discarded`);
        discarded++;
      }
      continue;
    }

    // ICP scoring hard stop: discard Tier C before reaching outreach queue
    const scored = scoreProfile(finalProfile);
    if (scored.tier === 'C') {
      discardStmt.run(JSON.stringify(finalProfile), now, row.id);
      console.log(`    ⚡ Tier C → discarded (${scored.reason})`);
      discarded++;
      continue;
    }

    const annotation = buildAutoAnnotation(row.id, finalProfile, crawled, thisCrawlFailed, scored.tier, scored.reason);
    reviewStmt.run(JSON.stringify(finalProfile), now, JSON.stringify(annotation), row.id);
    reviewed++;
  }

  console.log(`
[enrich-pending] Done.
  Crawled:        ${enriched}
  Skipped crawl:  ${skippedCrawl}
  Crawl errors:   ${crawlFailed}
  → reviewed:     ${reviewed}
  → needs_retry:  ${retried} (soft fail: crawl error + no signals)
  → discarded:    ${discarded} (hard fail: no signals / Tier C)`);
}

main().catch((err: unknown) => {
  console.error('[enrich-pending] Fatal:', err);
  process.exit(1);
});
