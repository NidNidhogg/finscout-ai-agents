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
import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { FirecrawlFetcher } from '../enrichment/website/FirecrawlFetcher';
import { createWebsiteEnricher, WebsiteEnrichmentError } from '../enrichment/EnrichmentEngine';
import { EnrichedProfileSchema, ReviewAnnotationSchema } from '../schema/enrichedProfile';
import type { EnrichedProfile, ReviewAnnotation } from '../schema/enrichedProfile';
import { scoreProfile } from '../sales-factory/scoreProfile';
import type { IcpTier } from '../sales-factory/scoreProfile';

// ── Config ────────────────────────────────────────────────────────────────────

const DB_PATH = process.env['REVIEW_DB_PATH'] ?? 'data/review-queue.db';
const SYSTEM_REVIEWER = 'system:enrich-pending';
const FOUNDER_MODEL = 'gemini-2.0-flash';
// Same cap as AgentExecutionHarness — keeps Gemini token cost predictable.
const FOUNDER_MARKDOWN_CAP = 8_000;

// ── Founder extraction ────────────────────────────────────────────────────────

interface FounderSignal {
  name?: string;
  role?: string;
  xHandle?: string;
  linkedinUrl?: string;
  githubUrl?: string;
  bioSnippet?: string;
  isFoundingEngineer?: boolean;
}

// Prioritise pages that are likely to name founders.
const TEAM_PAGE_RE = /\/(about|team|founders?|people|leadership|crew)\b/i;

// Concatenate markdown from crawled pages up to FOUNDER_MARKDOWN_CAP chars,
// with team/about pages sorted first to maximise signal density.
function buildFounderMarkdown(websiteMarkdown: Record<string, string>): string {
  const entries = Object.entries(websiteMarkdown).sort(([a], [b]) => {
    return (TEAM_PAGE_RE.test(a) ? 0 : 1) - (TEAM_PAGE_RE.test(b) ? 0 : 1);
  });
  let combined = '';
  for (const [url, md] of entries) {
    const chunk = `\n\n[Page: ${url}]\n${md}`;
    const remaining = FOUNDER_MARKDOWN_CAP - combined.length;
    if (remaining <= 100) break;
    combined += chunk.length <= remaining ? chunk : chunk.slice(0, remaining);
  }
  return combined.trim();
}

function isValidUrl(s: unknown): s is string {
  if (typeof s !== 'string' || !s) return false;
  try { new URL(s); return true; } catch { return false; }
}

// GitHub profile URLs have exactly one non-empty path segment (/username).
// Repo URLs (/org/repo) have two — we reject those to avoid noise.
function isGithubProfileUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (!u.hostname.includes('github.com')) return false;
    return u.pathname.split('/').filter(Boolean).length === 1;
  } catch { return false; }
}

function normaliseFounder(f: Record<string, unknown>): FounderSignal {
  const out: FounderSignal = {};
  if (typeof f['name'] === 'string' && f['name'])       out.name       = f['name'];
  if (typeof f['role'] === 'string' && f['role'])       out.role       = f['role'];
  // xHandle must start with @ — if the LLM omitted it, ignore.
  if (typeof f['xHandle'] === 'string' && f['xHandle'].startsWith('@'))
                                                         out.xHandle    = f['xHandle'];
  if (isValidUrl(f['linkedinUrl']) && String(f['linkedinUrl']).includes('linkedin.com'))
                                                         out.linkedinUrl = String(f['linkedinUrl']);
  if (isValidUrl(f['githubUrl']) && isGithubProfileUrl(String(f['githubUrl'])))
                                                         out.githubUrl  = String(f['githubUrl']);
  if (typeof f['bioSnippet'] === 'string' && f['bioSnippet'])
                                                         out.bioSnippet = f['bioSnippet'];
  if (typeof f['isFoundingEngineer'] === 'boolean')      out.isFoundingEngineer = f['isFoundingEngineer'];
  return out;
}

// Calls Gemini at temperature=0 with a strict JSON schema.
// Returns an empty array on any failure — founder extraction is non-fatal.
// Anti-hallucination: the prompt explicitly forbids inference from company name/domain.
async function extractFounders(
  markdown: string,
  geminiApiKey: string,
): Promise<FounderSignal[]> {
  if (!markdown) return [];

  const genAI = new GoogleGenerativeAI(geminiApiKey);
  const model = genAI.getGenerativeModel({
    model: FOUNDER_MODEL,
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: {
        type: SchemaType.OBJECT,
        properties: {
          founders: {
            type: SchemaType.ARRAY,
            items: {
              type: SchemaType.OBJECT,
              properties: {
                name:               { type: SchemaType.STRING },
                role:               { type: SchemaType.STRING },
                xHandle:            { type: SchemaType.STRING },
                linkedinUrl:        { type: SchemaType.STRING },
                githubUrl:          { type: SchemaType.STRING },
                bioSnippet:         { type: SchemaType.STRING },
                isFoundingEngineer: { type: SchemaType.BOOLEAN },
              },
            },
          },
        },
        required: ['founders'],
      },
    },
  });

  const prompt = `Extract founder and C-suite leadership signals from the website markdown below.

INVARIANT RULES — violation corrupts the sales pipeline:
1. Only extract names, handles, and URLs that appear VERBATIM in the markdown.
2. Do NOT infer, guess, or derive any value from company names, domain names, or surrounding context.
3. Do NOT hallucinate. If you are not certain a value is literally present, set that field to an empty string.
4. Only include people with a clear founding or C-suite role: CEO, CTO, CPO, co-founder, founding engineer. Exclude advisors, investors, and board members.
5. xHandle: must start with @. Only include if the @ handle appears literally in the text.
6. linkedinUrl: full https://linkedin.com/in/... URL only. Only if literally present.
7. githubUrl: full https://github.com/<username> profile URL only (not a repo). Only if literally present.
8. If no qualifying founder or C-suite executive is clearly identified, return {"founders": []}.

MARKDOWN:
${markdown}`;

  const result = await model.generateContent(prompt);
  const raw = JSON.parse(result.response.text()) as { founders?: unknown[] };

  if (!Array.isArray(raw.founders)) return [];

  return raw.founders
    .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
    .map(normaliseFounder)
    .filter((f) => Boolean(f.name ?? f.xHandle ?? f.linkedinUrl ?? f.githubUrl));
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface QueueRow {
  id: string;
  profile_json: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// 2-second inter-crawl delay keeps us within Firecrawl's concurrency limit during
// autonomous/cron runs. Applied only after a Firecrawl request was made (success or
// error) — pure skips (no URL, already crawled) don't consume Firecrawl capacity.
const CRAWL_THROTTLE_MS = 2_000;
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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
  // Optional — founder extraction is skipped gracefully when absent.
  const geminiApiKey = process.env['GEMINI_API_KEY'];

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
  let itemIndex = 0;

  for (const row of rows) {
    itemIndex++;
    const profile = EnrichedProfileSchema.parse(JSON.parse(row.profile_json));
    const { name, xHandle, websiteUrl } = profile.company;
    const label = `${name} (${xHandle ?? row.id.slice(0, 8)})`;

    console.log(`[enrich-pending] Processing item ${itemIndex} of ${rows.length}: ${name}…`);
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

        // Founder extraction — runs only when Gemini key is present.
        // Non-fatal: any error falls through with founders staying empty.
        if (geminiApiKey) {
          const founderMd = buildFounderMarkdown(finalProfile.rawContent.websiteMarkdown);
          if (founderMd) {
            try {
              const founders = await extractFounders(founderMd, geminiApiKey);
              if (founders.length > 0) {
                finalProfile = EnrichedProfileSchema.parse({
                  ...finalProfile,
                  team: { ...finalProfile.team, founders },
                });
                const names = founders
                  .map((f) => `${f.name ?? f.xHandle ?? '?'}${f.role ? ` (${f.role})` : ''}`)
                  .join(', ');
                console.log(`\n    founders: ${names}`);
              }
            } catch {
              // Extraction failed — continue without founder data.
            }
          }
        }

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

    // Throttle: pause after every Firecrawl request before the next iteration.
    // Placed here — before any `continue` — so it runs regardless of which
    // circuit-breaker path the item takes.
    if (crawled || thisCrawlFailed) {
      await sleep(CRAWL_THROTTLE_MS);
    }

    const now = new Date().toISOString();

    // Circuit breaker: no extractable technical signals.
    // If the crawl failed (network/scraping error), quarantine for retry rather
    // than permanently discarding — the missing signals may be a crawl artifact.
    if (!hasSubstantiveSignals(finalProfile)) {
      if (thisCrawlFailed) {
        const errorAnnotation = JSON.stringify({ error: `Firecrawl failed — no signals extractable: ${crawlErrorMsg}` });
        db.transaction(() => {
          retryStmt.run(JSON.stringify(finalProfile), now, errorAnnotation, row.id);
        })();
        console.log(`    ⏳ crawl failed + no signals → needs_retry`);
        retried++;
      } else {
        db.transaction(() => {
          discardStmt.run(JSON.stringify(finalProfile), now, row.id);
        })();
        console.log(`    ⚡ no technical signals → discarded`);
        discarded++;
      }
      continue;
    }

    // ICP scoring hard stop: discard Tier C before reaching outreach queue
    const scored = scoreProfile(finalProfile);
    if (scored.tier === 'C') {
      db.transaction(() => {
        discardStmt.run(JSON.stringify(finalProfile), now, row.id);
      })();
      console.log(`    ⚡ Tier C → discarded (${scored.reason})`);
      discarded++;
      continue;
    }

    const annotation = buildAutoAnnotation(row.id, finalProfile, crawled, thisCrawlFailed, scored.tier, scored.reason);
    db.transaction(() => {
      reviewStmt.run(JSON.stringify(finalProfile), now, JSON.stringify(annotation), row.id);
    })();
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
