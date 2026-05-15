/**
 * Temporary exploration script — not production code.
 * Fetches reviewed diamond records, runs deep-crawl Firecrawl on those with a websiteUrl,
 * prints raw results per page, then merges the enriched data back into the DB.
 */
import Database from 'better-sqlite3';
import { createReviewQueue } from '../review-queue/ReviewQueue';
import { FirecrawlFetcher } from '../enrichment/website/FirecrawlFetcher';
import { createWebsiteEnricher } from '../enrichment/EnrichmentEngine';
import { EnrichedProfileSchema } from '../schema/enrichedProfile';

const DB_PATH = process.env['REVIEW_DB_PATH'] ?? 'data/review-queue.db';
const DIAMOND_HANDLES = new Set(['@konnex_world', '@Americanfort_io', '@pinai_io']);

function hr(label: string): void {
  console.log('\n' + '═'.repeat(64));
  console.log(`  ${label}`);
  console.log('═'.repeat(64));
}

function field(name: string, value: string | undefined): void {
  console.log(`  ${name.padEnd(14)}: ${value ?? '(none)'}`);
}

async function main(): Promise<void> {
  const firecrawlApiKey = process.env['FIRECRAWL_API_KEY'];
  if (!firecrawlApiKey) {
    console.error('[firecrawl-test] ERROR: FIRECRAWL_API_KEY is required.');
    process.exit(1);
  }

  const db = new Database(DB_PATH);
  const queue = createReviewQueue({ db });

  const allReviewed = await queue.exportReviewed();
  const diamonds = allReviewed.filter(
    (item) => DIAMOND_HANDLES.has(item.profile.company.xHandle ?? ''),
  );

  if (diamonds.length === 0) {
    console.error('[firecrawl-test] No diamond records found — run inject-diamonds first.');
    process.exit(1);
  }

  const pageFetcher = new FirecrawlFetcher({ apiKey: firecrawlApiKey });
  const websiteEnricher = createWebsiteEnricher({ pageFetcher });

  for (const item of diamonds) {
    const profile = item.profile;
    const websiteUrl = profile.company.websiteUrl;

    hr(`${profile.company.name}  ·  ${profile.company.xHandle}`);
    field('ID', item.id.slice(0, 8) + '…');
    field('websiteUrl', websiteUrl);

    if (!websiteUrl) {
      console.log('\n  ⊘  No websiteUrl — Firecrawl skipped.\n');
      continue;
    }

    if (profile.sources.websiteCrawl?.lastFetched) {
      console.log(`\n  ⊘  Already crawled at ${profile.sources.websiteCrawl.lastFetched.slice(0, 10)} — skipping.\n`);
      continue;
    }

    console.log('\n  → Calling Firecrawl deep-crawl (limit: 5 pages, priority: /docs /whitepaper /developers /about)…');

    let enrichData;
    try {
      enrichData = await websiteEnricher.enrich(websiteUrl);
    } catch (err) {
      console.error(`\n  ✗  Firecrawl error: ${err instanceof Error ? err.message : String(err)}\n`);
      continue;
    }

    console.log(`\n  ── Pages crawled (${enrichData.pagesFetched.length}) ─────────────────────────────────`);
    for (const page of enrichData.pagesFetched) {
      console.log(`\n  [${page.title || '(no title)'}]`);
      field('  url', page.url);
      const preview = page.markdown.slice(0, 400).replace(/\n{3,}/g, '\n\n').trim();
      if (preview) {
        preview.split('\n').forEach((line) => console.log(`    ${line}`));
        if (page.markdown.length > 400) console.log('    … [truncated]');
      } else {
        console.log('    (empty)');
      }
    }

    console.log('\n  ── Extracted signals ──────────────────────────────────');
    field('stack', enrichData.extractedProduct.stackMentions.join(', ') || '(none detected)');
    field('arch terms', enrichData.extractedProduct.architectureTerms.join(', ') || '(none detected)');

    // Merge Firecrawl results back into the stored profile
    const maxFetchedAt = enrichData.pagesFetched.reduce(
      (max, p) => (p.fetchedAt > max ? p.fetchedAt : max),
      new Date(0),
    );

    const updatedProfile = EnrichedProfileSchema.parse({
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

    db.prepare('UPDATE queue_items SET profile_json = ? WHERE id = ?').run(
      JSON.stringify(updatedProfile),
      item.id,
    );

    console.log('\n  ✓  Profile updated in DB with deep-crawl data.');
  }

  console.log('\n' + '═'.repeat(64));
  console.log('  Done.');
  console.log('═'.repeat(64) + '\n');
}

main().catch((err: unknown) => {
  console.error('[firecrawl-test] Fatal:', err);
  process.exit(1);
});
