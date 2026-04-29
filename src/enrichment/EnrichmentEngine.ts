import { randomUUID } from 'crypto';
import type { ResolvedFingerprint, Signal } from '../fingerprint/schemas';
import type { EnrichedProfile, FundingStage } from '../schema/enrichedProfile';
import { EnrichedProfileSchema } from '../schema/enrichedProfile';
import type { CompanyCandidate, PollOpts, XSignalSource } from './x-signal/XSignalSource';
import { XRateLimitError } from './x-signal/XSignalSource';

// ── PageFetcher ───────────────────────────────────────────────────────────────

export interface FetchOpts {
  timeoutMs?: number;
}

export interface CrawlOpts {
  maxPages?: number;
  timeoutMs?: number;
  includePaths?: string[];
}

export interface FetchedPage {
  url: string;
  markdown: string;
  title: string;
  metadata: Record<string, unknown>;
  fetchedAt: Date;
}

export interface PageFetcher {
  fetch(url: string, opts?: FetchOpts): Promise<FetchedPage>;
  crawl(baseUrl: string, opts?: CrawlOpts): Promise<FetchedPage[]>;
}

// ── WebsiteEnricher ───────────────────────────────────────────────────────────

export interface ExtractedProductData {
  description?: string;
  selfClaimedCategory?: string;
  stackMentions: string[];
  architectureTerms: string[];
  antiSignalTerms: string[];
  evidence: Array<{
    page: string;
    snippet: string;
    relevance: 'high' | 'medium' | 'low';
  }>;
}

export interface ExtractedTeamData {
  estimatedHeadcount?: number;
  headcountSource?: 'about_page' | 'careers_count' | 'unknown';
  founders: Array<{
    name?: string;
    role?: string;
    xHandle?: string;
    linkedinUrl?: string;
    bioSnippet?: string;
    isFoundingEngineer?: boolean;
  }>;
  openRoles: Array<{
    title: string;
    stackHints: string[];
    seniority?: 'junior' | 'mid' | 'senior' | 'lead';
  }>;
}

export interface ExtractedFundingData {
  amountUSD?: number;
  stage?: FundingStage;
  claimedAt?: string;
  announcementUrl?: string;
  rawText?: string;
}

export interface WebsiteEnrichmentData {
  pagesFetched: FetchedPage[];
  websiteMarkdown: Record<string, string>;
  extractedProduct: ExtractedProductData;
  extractedTeam: ExtractedTeamData;
  extractedFunding?: ExtractedFundingData;
}

export interface WebsiteEnricherDeps {
  pageFetcher: PageFetcher;
}

export interface WebsiteEnricher {
  enrich(websiteUrl: string): Promise<WebsiteEnrichmentData>;
}

// ── ProfileComposer ───────────────────────────────────────────────────────────

export interface ProfileComposer {
  compose(
    candidate: CompanyCandidate,
    websiteData: WebsiteEnrichmentData | null,
    fingerprints: ResolvedFingerprint[],
  ): EnrichedProfile;
}

// ── EnrichmentEngine ──────────────────────────────────────────────────────────

export interface EnrichmentRunResult {
  profilesEnriched: EnrichedProfile[];
  failedCandidates: Array<{ candidate: CompanyCandidate; error: unknown }>;
  status: 'ok' | 'rate_limited' | 'auth_error' | 'network_error';
  retryAfterMs?: number;
}

export interface EnrichmentEngineDeps {
  xSignalSource: XSignalSource;
  websiteEnricher: WebsiteEnricher;
  profileComposer: ProfileComposer;
  fingerprints: ResolvedFingerprint[];
}

export interface EnrichmentEngine {
  enrich(candidate: CompanyCandidate): Promise<EnrichedProfile>;
  run(opts?: PollOpts): Promise<EnrichmentRunResult>;
}

// ── Error classes ─────────────────────────────────────────────────────────────

export class EnrichmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnrichmentError';
  }
}

export class WebsiteEnrichmentError extends EnrichmentError {
  constructor(
    public readonly websiteUrl: string,
    public readonly cause?: unknown,
  ) {
    super(`Website enrichment failed for: ${websiteUrl}`);
    this.name = 'WebsiteEnrichmentError';
  }
}

export class PageFetchTimeoutError extends WebsiteEnrichmentError {
  constructor(websiteUrl: string) {
    super(websiteUrl);
    this.name = 'PageFetchTimeoutError';
  }
}

export class PageFetchNetworkError extends WebsiteEnrichmentError {
  constructor(websiteUrl: string, cause?: unknown) {
    super(websiteUrl, cause);
    this.name = 'PageFetchNetworkError';
  }
}

export class ProfileComposerError extends EnrichmentError {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ProfileComposerError';
  }
}

// ── Extraction vocabulary ─────────────────────────────────────────────────────

const ARCHITECTURE_VOCABULARY = [
  'multisig', 'stablecoin', 'smart contract', 'zero knowledge', 'zk-proof', 'zkp',
  'merkle', 'settlement', 'custody', 'vesting', 'validator', 'oracle', 'amm', 'dex',
  'tvl', 'flash loan', 'bridge', 'cross-chain', 'layer 2', 'l2', 'rollup', 'sequencer',
  'restaking', 'hsm', 'key management', 'threshold signature', 'mev', 'intent',
  'account abstraction', 'erc-4337', 'yield', 'liquidity', 'vault', 'nft',
];

const STACK_VOCABULARY = [
  'Rust', 'Solana', 'Ethereum', 'Python', 'Go', 'TypeScript', 'JavaScript',
  'Move', 'Vyper', 'Solidity', 'Cairo', 'Haskell', 'Cosmos', 'Polkadot',
  'NEAR', 'Avalanche', 'Polygon',
];

function extractArchitectureTerms(text: string): string[] {
  const lower = text.toLowerCase();
  return ARCHITECTURE_VOCABULARY.filter((term) => lower.includes(term.toLowerCase()));
}

function extractStackMentions(text: string): string[] {
  const lower = text.toLowerCase();
  return STACK_VOCABULARY.filter((term) => lower.includes(term.toLowerCase()));
}

// ── createWebsiteEnricher ─────────────────────────────────────────────────────

export function createWebsiteEnricher(deps: WebsiteEnricherDeps): WebsiteEnricher {
  const { pageFetcher } = deps;

  return {
    async enrich(websiteUrl: string): Promise<WebsiteEnrichmentData> {
      let pages: FetchedPage[];
      try {
        pages = await pageFetcher.crawl(websiteUrl, {});
      } catch (err) {
        const isTimeout =
          err instanceof Error &&
          (err.name === 'TimeoutError' || err.message.toLowerCase().includes('timeout'));
        if (isTimeout) throw new PageFetchTimeoutError(websiteUrl);
        throw new PageFetchNetworkError(websiteUrl, err);
      }

      const websiteMarkdown: Record<string, string> = {};
      for (const page of pages) {
        websiteMarkdown[page.url] = page.markdown;
      }

      const allMarkdown = pages.map((p) => p.markdown).join('\n');
      const architectureTerms = extractArchitectureTerms(allMarkdown);
      const stackMentions = extractStackMentions(allMarkdown);

      return {
        pagesFetched: pages,
        websiteMarkdown,
        extractedProduct: {
          stackMentions,
          architectureTerms,
          antiSignalTerms: [],
          evidence: [],
        },
        extractedTeam: {
          founders: [],
          openRoles: [],
        },
      };
    },
  };
}

// ── createProfileComposer ─────────────────────────────────────────────────────

export function createProfileComposer(coreSignals: Signal[]): ProfileComposer {
  const coreTermSet = new Set(coreSignals.map((s) => s.term.toLowerCase()));

  return {
    compose(
      candidate: CompanyCandidate,
      websiteData: WebsiteEnrichmentData | null,
      fingerprints: ResolvedFingerprint[],
    ): EnrichedProfile {
      // Company name
      let companyName: string;
      if (candidate.resolvedCompany.name) {
        companyName = candidate.resolvedCompany.name;
      } else {
        const stripped = candidate.authorHandle.replace(/^@/, '');
        if (!stripped || stripped.trim() === '') {
          throw new ProfileComposerError('missing company name source');
        }
        companyName = stripped.charAt(0).toUpperCase() + stripped.slice(1);
      }

      const normalizedName = companyName.toLowerCase().replace(/\s+/g, ' ').trim();

      // Signal surface for cell matching
      const signalTerms: string[] = websiteData
        ? [
            ...websiteData.extractedProduct.architectureTerms,
            ...websiteData.extractedProduct.stackMentions,
          ]
        : candidate.matchedPrimarySignals;

      const signalTermsLower = signalTerms.map((t) => t.toLowerCase());

      // Competency cell matches — one entry per fingerprint
      const competencyCellMatches = fingerprints.map((fp) => {
        const matchedSignals = fp.primarySignals
          .filter((s) => signalTermsLower.includes(s.term.toLowerCase()))
          .map((s) => {
            // Preserve case from the signal terms surface
            const idx = signalTerms.findIndex(
              (t) => t.toLowerCase() === s.term.toLowerCase(),
            );
            return idx >= 0 ? signalTerms[idx] : s.term;
          });

        const totalCellTermCount = fp.primarySignals.length;
        const score = totalCellTermCount === 0 ? 0 : matchedSignals.length / totalCellTermCount;

        const matchedCoreSignals = matchedSignals.filter((term) =>
          coreTermSet.has(term.toLowerCase()),
        );

        return { cell: fp.cell, matchedSignals, matchedCoreSignals, score };
      });

      // sources.websiteCrawl — only when websiteData non-null
      let websiteCrawl: EnrichedProfile['sources']['websiteCrawl'];
      if (websiteData !== null) {
        const maxFetchedAt =
          websiteData.pagesFetched.length > 0
            ? websiteData.pagesFetched.reduce(
                (max, p) => (p.fetchedAt > max ? p.fetchedAt : max),
                new Date(0),
              )
            : new Date(0);
        websiteCrawl = {
          lastFetched: maxFetchedAt.toISOString(),
          pagesCrawled: websiteData.pagesFetched.map((p) => p.url),
          fetcher: 'firecrawl',
        };
      }

      const assembled = {
        id: randomUUID(),
        enrichedAt: new Date().toISOString(),
        schemaVersion: '1.0.0' as const,
        sources: {
          xApi: {
            lastFetched: candidate.discoveredAt,
            tweetsConsidered: 1,
            founderHandle: candidate.authorHandle,
          },
          websiteCrawl,
        },
        company: {
          name: companyName,
          normalizedName,
          websiteUrl: candidate.resolvedCompany.websiteUrl,
          xHandle: candidate.authorHandle,
        },
        funding: {
          claimed: {
            rawText: candidate.tweetText,
            templateMatched: candidate.matchedTemplates,
            claimedAt: candidate.postedAt,
          },
        },
        product: {
          description: websiteData?.extractedProduct.description,
          selfClaimedCategory: websiteData?.extractedProduct.selfClaimedCategory,
          stackMentions: websiteData?.extractedProduct.stackMentions ?? [],
          architectureTerms: websiteData?.extractedProduct.architectureTerms ?? [],
          antiSignalTerms: websiteData?.extractedProduct.antiSignalTerms ?? [],
          competencyCellMatches,
          evidence: websiteData?.extractedProduct.evidence ?? [],
        },
        team: {
          estimatedHeadcount: websiteData?.extractedTeam.estimatedHeadcount,
          headcountSource: websiteData?.extractedTeam.headcountSource,
          founders: websiteData?.extractedTeam.founders ?? [],
          openRoles: websiteData?.extractedTeam.openRoles,
        },
        rawContent: {
          websiteMarkdown: websiteData?.websiteMarkdown ?? {},
          sourceTweets: [
            {
              id: candidate.tweetId,
              text: candidate.tweetText,
              postedAt: candidate.postedAt,
              authorHandle: candidate.authorHandle,
              authorBio: candidate.authorBio,
            },
          ],
        },
      };

      try {
        return EnrichedProfileSchema.parse(assembled);
      } catch (err) {
        throw new ProfileComposerError('Profile assembly failed schema validation', err);
      }
    },
  };
}

// ── createEnrichmentEngine ────────────────────────────────────────────────────

export function createEnrichmentEngine(deps: EnrichmentEngineDeps): EnrichmentEngine {
  const { xSignalSource, websiteEnricher, profileComposer, fingerprints } = deps;

  const engine: EnrichmentEngine = {
    async enrich(candidate: CompanyCandidate): Promise<EnrichedProfile> {
      let websiteData: WebsiteEnrichmentData | null;
      try {
        websiteData = await websiteEnricher.enrich(candidate.resolvedCompany.websiteUrl);
      } catch (err) {
        if (err instanceof WebsiteEnrichmentError) {
          websiteData = null;
        } else {
          throw err;
        }
      }
      return profileComposer.compose(candidate, websiteData, fingerprints);
    },

    async run(opts?: PollOpts): Promise<EnrichmentRunResult> {
      let candidates: CompanyCandidate[];
      try {
        candidates = await xSignalSource.pollOnce(opts);
      } catch (err) {
        if (err instanceof XRateLimitError) {
          return {
            status: 'rate_limited',
            retryAfterMs: err.retryAfterMs,
            profilesEnriched: [],
            failedCandidates: [],
          };
        }
        throw err;
      }

      // Deduplicate by websiteUrl within a single poll
      const seen = new Set<string>();
      const uniqueCandidates = candidates.filter((c) => {
        const url = c.resolvedCompany.websiteUrl;
        if (seen.has(url)) return false;
        seen.add(url);
        return true;
      });

      const profilesEnriched: EnrichedProfile[] = [];
      const failedCandidates: Array<{ candidate: CompanyCandidate; error: unknown }> = [];

      for (const candidate of uniqueCandidates) {
        try {
          const profile = await engine.enrich(candidate);
          profilesEnriched.push(profile);
        } catch (err) {
          failedCandidates.push({ candidate, error: err });
        }
      }

      return { status: 'ok', profilesEnriched, failedCandidates };
    },
  };

  return engine;
}
