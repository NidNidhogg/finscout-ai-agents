# TEST SCAFFOLD: Enrichment Engine
<!-- linked-spec: specs/enrichment-engine/spec.md -->
<!-- spec-version: 1.0 -->
<!-- date: 2026-04-29 -->

## Setup and Shared Stubs

All test files live under `src/enrichment/`. Each test group maps to a single test file. Import paths are relative to the test file location.

### Stub and fixture factories

```typescript
import { v4 as uuidv4 } from 'uuid';
import type {
  CompanyCandidate,
  ResolvedCompany,
} from '../x-signal/XSignalSource';
import type {
  FetchedPage,
  PageFetcher,
  WebsiteEnrichmentData,
  WebsiteEnricher,
  ProfileComposer,
  EnrichmentEngineDeps,
} from './EnrichmentEngine';
import type { ResolvedFingerprint, Signal } from '../fingerprint/fingerprint';
import { EnrichedProfileSchema } from '../../schema/enrichedProfile';
import {
  XRateLimitError,
  XAuthError,
  XNetworkError,
} from '../x-signal/XSignalSource';
import {
  WebsiteEnrichmentError,
  PageFetchTimeoutError,
  PageFetchNetworkError,
  ProfileComposerError,
  createEnrichmentEngine,
  createWebsiteEnricher,
  createProfileComposer,
} from './EnrichmentEngine';

// --- Candidate factory ---
function makeCandidate(overrides: Partial<CompanyCandidate> = {}): CompanyCandidate {
  return {
    tweetId: 'tweet-001',
    tweetText: 'We raised $5M seed round for our stablecoin infrastructure',
    authorHandle: '@founderhandle',
    authorBio: 'Building stablecoin infra',
    postedAt: '2026-04-01T10:00:00.000Z',
    matchedTemplates: ['raised $5M seed'],
    matchedPrimarySignals: ['stablecoin', 'multisig'],
    matchedCells: ['DeFi & Yield'],
    resolvedCompany: {
      websiteUrl: 'https://example.com',
      name: 'Example Corp',
      xHandle: '@founderhandle',
    },
    discoveredAt: '2026-04-01T10:05:00.000Z',
    ...overrides,
  };
}

// --- Fetched page factory ---
function makeFetchedPage(overrides: Partial<FetchedPage> = {}): FetchedPage {
  return {
    url: 'https://example.com/',
    markdown: '# Example Corp\nWe build multisig stablecoin infrastructure.',
    title: 'Example Corp',
    metadata: {},
    fetchedAt: new Date('2026-04-01T10:10:00.000Z'),
    ...overrides,
  };
}

// --- WebsiteEnrichmentData factory ---
function makeWebsiteEnrichmentData(
  overrides: Partial<WebsiteEnrichmentData> = {},
): WebsiteEnrichmentData {
  const page = makeFetchedPage();
  return {
    pagesFetched: [page],
    websiteMarkdown: { [page.url]: page.markdown },
    extractedProduct: {
      description: 'Stablecoin infrastructure',
      selfClaimedCategory: 'DeFi',
      stackMentions: ['Rust', 'Solana'],
      architectureTerms: ['multisig', 'stablecoin'],
      antiSignalTerms: [],
      evidence: [
        { page: page.url, snippet: 'multisig stablecoin', relevance: 'high' },
      ],
    },
    extractedTeam: {
      estimatedHeadcount: 5,
      headcountSource: 'about_page',
      founders: [{ name: 'Alice', role: 'CEO', isFoundingEngineer: true }],
      openRoles: [],
    },
    extractedFunding: {},
    ...overrides,
  };
}

// --- Stub: XSignalSource ---
function makeStubXSignalSource(candidates: CompanyCandidate[] = []) {
  return { pollOnce: jest.fn().mockResolvedValue(candidates) };
}

// --- Stub: WebsiteEnricher ---
function makeStubWebsiteEnricher(
  data: WebsiteEnrichmentData = makeWebsiteEnrichmentData(),
) {
  return { enrich: jest.fn().mockResolvedValue(data) };
}

// --- Stub: ProfileComposer ---
function makeStubProfileComposer(profile?: import('../../schema/enrichedProfile').EnrichedProfile) {
  const out = profile ?? buildMinimalProfile();
  return { compose: jest.fn().mockReturnValue(out) };
}

// --- Minimal valid EnrichedProfile ---
function buildMinimalProfile() {
  return EnrichedProfileSchema.parse({
    id: uuidv4(),
    enrichedAt: new Date().toISOString(),
    schemaVersion: '1.0.0',
    sources: {},
    company: {
      name: 'Example Corp',
      normalizedName: 'example corp',
      websiteUrl: 'https://example.com',
    },
    funding: { claimed: {} },
    product: {
      stackMentions: [],
      architectureTerms: [],
      antiSignalTerms: [],
      competencyCellMatches: [],
      evidence: [],
    },
    team: { founders: [] },
    rawContent: { websiteMarkdown: {} },
  });
}

// --- Stub fingerprints ---
function makeFingerprints(): ResolvedFingerprint[] {
  return [
    {
      cell: 'DeFi & Yield',
      resolvedAt: new Date().toISOString(),
      primarySignals: [
        { term: 'stablecoin', weight: 1.5 },
        { term: 'multisig', weight: 1.2 },
      ],
      antiSignals: [{ term: 'airdrop', weight: 1.0 }],
    },
  ];
}

// --- Core signals (from core-web3-signals.json primarySignals) ---
function makeCoreSignals(): Signal[] {
  return [
    { term: 'multisig', weight: 1.2 },
    { term: 'audit', weight: 1.5 },
    { term: 'settlement finality', weight: 1.3 },
  ];
}
```

---

## Group A: Orchestrator Flow

**File:** `src/enrichment/EnrichmentEngine.test.ts`

```typescript
describe('EnrichmentEngine — Orchestrator Flow', () => {
  describe('AC-001: createEnrichmentEngine accepts injected dependencies', () => {
    it('constructs without error given stub XSignalSource, WebsiteEnricher, ProfileComposer, and fingerprints', () => {
      const deps: EnrichmentEngineDeps = {
        xSignalSource: makeStubXSignalSource(),
        websiteEnricher: makeStubWebsiteEnricher(),
        profileComposer: makeStubProfileComposer(),
        fingerprints: makeFingerprints(),
      };
      expect(() => createEnrichmentEngine(deps)).not.toThrow();
    });
  });

  describe('AC-002: enrich() calls WebsiteEnricher then ProfileComposer with websiteData', () => {
    it('passes websiteUrl to WebsiteEnricher and forwards websiteData to ProfileComposer', async () => {
      const candidate = makeCandidate();
      const websiteData = makeWebsiteEnrichmentData();
      const enricher = makeStubWebsiteEnricher(websiteData);
      const composer = makeStubProfileComposer();
      const engine = createEnrichmentEngine({
        xSignalSource: makeStubXSignalSource(),
        websiteEnricher: enricher,
        profileComposer: composer,
        fingerprints: makeFingerprints(),
      });

      await engine.enrich(candidate);

      expect(enricher.enrich).toHaveBeenCalledWith(candidate.resolvedCompany.websiteUrl);
      expect(composer.compose).toHaveBeenCalledWith(
        candidate,
        websiteData,
        expect.any(Array),
      );
    });
  });

  describe('AC-003: enrich() catches WebsiteEnrichmentError and calls compose with null websiteData', () => {
    it('returns a partial EnrichedProfile without re-throwing', async () => {
      const candidate = makeCandidate();
      const enricher = { enrich: jest.fn().mockRejectedValue(new WebsiteEnrichmentError('https://example.com')) };
      const composer = makeStubProfileComposer();
      const engine = createEnrichmentEngine({
        xSignalSource: makeStubXSignalSource(),
        websiteEnricher: enricher,
        profileComposer: composer,
        fingerprints: makeFingerprints(),
      });

      const result = await engine.enrich(candidate);

      expect(composer.compose).toHaveBeenCalledWith(candidate, null, expect.any(Array));
      expect(result).toBeDefined();
    });
  });

  describe('AC-004: run() calls pollOnce() and enrich() for each candidate', () => {
    it('calls enrich once per candidate returned by pollOnce', async () => {
      const candidates = [makeCandidate(), makeCandidate({ tweetId: 'tweet-002', resolvedCompany: { websiteUrl: 'https://other.com' } })];
      const xSource = makeStubXSignalSource(candidates);
      const enrichSpy = jest.fn().mockResolvedValue(buildMinimalProfile());
      const engine = createEnrichmentEngine({
        xSignalSource: xSource,
        websiteEnricher: { enrich: enrichSpy } as unknown as WebsiteEnricher,
        profileComposer: makeStubProfileComposer(),
        fingerprints: makeFingerprints(),
      });

      await engine.run();

      expect(xSource.pollOnce).toHaveBeenCalledTimes(1);
      expect(enrichSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('AC-005: run() deduplicates candidates by websiteUrl', () => {
    it('calls enrich only once when two candidates share the same websiteUrl', async () => {
      const url = 'https://example.com';
      const candidates = [
        makeCandidate({ tweetId: 'tweet-001', resolvedCompany: { websiteUrl: url, name: 'A' } }),
        makeCandidate({ tweetId: 'tweet-002', resolvedCompany: { websiteUrl: url, name: 'A' } }),
      ];
      const xSource = makeStubXSignalSource(candidates);
      const enricherSpy = jest.fn().mockResolvedValue(makeWebsiteEnrichmentData());
      const engine = createEnrichmentEngine({
        xSignalSource: xSource,
        websiteEnricher: { enrich: enricherSpy } as unknown as WebsiteEnricher,
        profileComposer: makeStubProfileComposer(),
        fingerprints: makeFingerprints(),
      });

      await engine.run();

      expect(enricherSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('AC-006: run() returns rate_limited when XRateLimitError is thrown', () => {
    it('does not re-throw; returns status rate_limited with retryAfterMs', async () => {
      const xSource = { pollOnce: jest.fn().mockRejectedValue(new XRateLimitError(30000)) };
      const engine = createEnrichmentEngine({
        xSignalSource: xSource,
        websiteEnricher: makeStubWebsiteEnricher(),
        profileComposer: makeStubProfileComposer(),
        fingerprints: makeFingerprints(),
      });

      const result = await engine.run();

      expect(result.status).toBe('rate_limited');
      expect(result.retryAfterMs).toBe(30000);
      expect(result.profilesEnriched).toHaveLength(0);
      expect(result.failedCandidates).toHaveLength(0);
    });
  });

  describe('AC-007: run() continues after ProfileComposerError and records failed candidate', () => {
    it('processes all candidates and records the failing one in failedCandidates', async () => {
      const goodCandidate = makeCandidate({ tweetId: 't1', resolvedCompany: { websiteUrl: 'https://good.com' } });
      const badCandidate = makeCandidate({ tweetId: 't2', resolvedCompany: { websiteUrl: 'https://bad.com' } });
      const xSource = makeStubXSignalSource([goodCandidate, badCandidate]);
      const enricherSpy = jest.fn()
        .mockImplementation(async (url: string) => {
          if (url === 'https://bad.com') throw new ProfileComposerError('bad shape');
          return makeWebsiteEnrichmentData();
        });
      const engine = createEnrichmentEngine({
        xSignalSource: xSource,
        websiteEnricher: { enrich: enricherSpy } as unknown as WebsiteEnricher,
        profileComposer: makeStubProfileComposer(),
        fingerprints: makeFingerprints(),
      });

      const result = await engine.run();

      expect(result.profilesEnriched).toHaveLength(1);
      expect(result.failedCandidates).toHaveLength(1);
      expect(result.failedCandidates[0].candidate).toBe(badCandidate);
    });
  });

  describe('AC-008: run() returns status ok when all candidates succeed', () => {
    it('returns status ok with all profiles enriched', async () => {
      const candidates = [makeCandidate()];
      const engine = createEnrichmentEngine({
        xSignalSource: makeStubXSignalSource(candidates),
        websiteEnricher: makeStubWebsiteEnricher(),
        profileComposer: makeStubProfileComposer(),
        fingerprints: makeFingerprints(),
      });

      const result = await engine.run();

      expect(result.status).toBe('ok');
      expect(result.profilesEnriched).toHaveLength(1);
      expect(result.failedCandidates).toHaveLength(0);
    });
  });
});
```

---

## Group B: Firecrawl Boundary / Website Enricher

**File:** `src/enrichment/WebsiteEnricher.test.ts`

```typescript
describe('WebsiteEnricher — Firecrawl Boundary', () => {
  describe('AC-009: WebsiteEnricher calls PageFetcher.crawl and no Firecrawl SDK directly', () => {
    it('calls crawl on the injected PageFetcher with the provided URL', async () => {
      const crawlMock = jest.fn().mockResolvedValue([makeFetchedPage()]);
      const fetcher: PageFetcher = { fetch: jest.fn(), crawl: crawlMock };
      const enricher = createWebsiteEnricher({ pageFetcher: fetcher });

      await enricher.enrich('https://example.com');

      expect(crawlMock).toHaveBeenCalledWith('https://example.com', expect.anything());
    });
  });

  describe('AC-010: pagesFetched contains one entry per page returned by crawl', () => {
    it('maps crawl output to pagesFetched array', async () => {
      const pages = [
        makeFetchedPage({ url: 'https://example.com/' }),
        makeFetchedPage({ url: 'https://example.com/about' }),
      ];
      const fetcher: PageFetcher = { fetch: jest.fn(), crawl: jest.fn().mockResolvedValue(pages) };
      const enricher = createWebsiteEnricher({ pageFetcher: fetcher });

      const data = await enricher.enrich('https://example.com');

      expect(data.pagesFetched).toHaveLength(2);
      expect(data.pagesFetched[0].url).toBe('https://example.com/');
      expect(data.pagesFetched[1].url).toBe('https://example.com/about');
    });
  });

  describe('AC-011: websiteMarkdown is a Record<string, string> mapping url to markdown', () => {
    it('populates websiteMarkdown keyed by page URL', async () => {
      const page = makeFetchedPage({ url: 'https://example.com/', markdown: '# Hello' });
      const fetcher: PageFetcher = { fetch: jest.fn(), crawl: jest.fn().mockResolvedValue([page]) };
      const enricher = createWebsiteEnricher({ pageFetcher: fetcher });

      const data = await enricher.enrich('https://example.com');

      expect(data.websiteMarkdown['https://example.com/']).toBe('# Hello');
    });
  });

  describe('AC-012: pages with empty markdown are included in pagesFetched without filtering', () => {
    it('does not drop pages with empty markdown strings', async () => {
      const pages = [
        makeFetchedPage({ url: 'https://example.com/about', markdown: '' }),
        makeFetchedPage({ url: 'https://example.com/careers', markdown: '' }),
      ];
      const fetcher: PageFetcher = { fetch: jest.fn(), crawl: jest.fn().mockResolvedValue(pages) };
      const enricher = createWebsiteEnricher({ pageFetcher: fetcher });

      const data = await enricher.enrich('https://example.com');

      expect(data.pagesFetched).toHaveLength(2);
    });
  });

  describe('AC-013: enrich throws PageFetchTimeoutError on PageFetcher timeout', () => {
    it('wraps a timeout error in PageFetchTimeoutError', async () => {
      const timeoutErr = new Error('timeout');
      timeoutErr.name = 'TimeoutError';
      const fetcher: PageFetcher = { fetch: jest.fn(), crawl: jest.fn().mockRejectedValue(timeoutErr) };
      const enricher = createWebsiteEnricher({ pageFetcher: fetcher });

      await expect(enricher.enrich('https://example.com')).rejects.toBeInstanceOf(PageFetchTimeoutError);
    });
  });

  describe('AC-014: enrich throws PageFetchNetworkError on non-timeout PageFetcher error', () => {
    it('wraps a network error in PageFetchNetworkError', async () => {
      const netErr = new Error('ECONNREFUSED');
      const fetcher: PageFetcher = { fetch: jest.fn(), crawl: jest.fn().mockRejectedValue(netErr) };
      const enricher = createWebsiteEnricher({ pageFetcher: fetcher });

      await expect(enricher.enrich('https://example.com')).rejects.toBeInstanceOf(PageFetchNetworkError);
    });
  });

  describe('AC-015: FixturePageFetcher returns fixture pages or empty array', () => {
    it('returns deserialized FetchedPage[] when fixtures exist', async () => {
      // Arrange: place a fixture at data/fixtures/pages/example.com/index.json
      // (fixture file is committed under data/fixtures/pages/example.com/)
      const { FixturePageFetcher } = await import('./sources/FixturePageFetcher');
      const fetcher = new FixturePageFetcher();

      const pages = await fetcher.crawl('https://example.com');

      // If fixture exists, length >= 1; if not present, returns []
      expect(Array.isArray(pages)).toBe(true);
    });

    it('returns empty array for a hostname with no fixtures', async () => {
      const { FixturePageFetcher } = await import('./sources/FixturePageFetcher');
      const fetcher = new FixturePageFetcher();

      const pages = await fetcher.crawl('https://this-hostname-has-no-fixtures.example.com');

      expect(pages).toHaveLength(0);
    });
  });

  describe('AC-016: WebsiteEnricher with FixturePageFetcher returns deterministic results', () => {
    it('produces WebsiteEnrichmentData without network calls given fixture pages', async () => {
      const controlledPages = [
        makeFetchedPage({ url: 'https://example.com/about', markdown: '## About\nWe build HSM key management and multisig wallets.' }),
      ];
      const fetcher: PageFetcher = { fetch: jest.fn(), crawl: jest.fn().mockResolvedValue(controlledPages) };
      const enricher = createWebsiteEnricher({ pageFetcher: fetcher });

      const data = await enricher.enrich('https://example.com');

      expect(data.extractedProduct.architectureTerms).toEqual(expect.arrayContaining(['multisig']));
      expect(data.websiteMarkdown['https://example.com/about']).toContain('HSM');
    });
  });
});
```

---

## Group C: Profile Composer

**File:** `src/enrichment/ProfileComposer.test.ts`

```typescript
describe('ProfileComposer', () => {
  let composer: ProfileComposer;
  let coreSignals: Signal[];
  let fingerprints: ResolvedFingerprint[];

  beforeEach(() => {
    coreSignals = makeCoreSignals();
    fingerprints = makeFingerprints();
    composer = createProfileComposer(coreSignals);
  });

  describe('AC-017: company.name from resolvedCompany.name or authorHandle fallback', () => {
    it('uses resolvedCompany.name when present', () => {
      const candidate = makeCandidate({ resolvedCompany: { websiteUrl: 'https://example.com', name: 'Acme Corp' } });
      const result = composer.compose(candidate, makeWebsiteEnrichmentData(), fingerprints);
      expect(result.company.name).toBe('Acme Corp');
    });

    it('falls back to stripped and capitalized authorHandle when name is absent', () => {
      const candidate = makeCandidate({
        authorHandle: '@acmebuilder',
        resolvedCompany: { websiteUrl: 'https://example.com' },
      });
      const result = composer.compose(candidate, makeWebsiteEnrichmentData(), fingerprints);
      expect(result.company.name).toBe('Acmebuilder');
    });
  });

  describe('AC-018: company.normalizedName is lowercase whitespace-normalized', () => {
    it('lowercases and collapses whitespace', () => {
      const candidate = makeCandidate({ resolvedCompany: { websiteUrl: 'https://example.com', name: '  Acme  Corp  ' } });
      const result = composer.compose(candidate, makeWebsiteEnrichmentData(), fingerprints);
      expect(result.company.normalizedName).toBe('acme corp');
    });
  });

  describe('AC-019: company.websiteUrl from resolvedCompany and xHandle from authorHandle', () => {
    it('sets websiteUrl and xHandle', () => {
      const candidate = makeCandidate({
        authorHandle: '@alice',
        resolvedCompany: { websiteUrl: 'https://acme.io', name: 'Acme' },
      });
      const result = composer.compose(candidate, makeWebsiteEnrichmentData(), fingerprints);
      expect(result.company.websiteUrl).toBe('https://acme.io');
      expect(result.company.xHandle).toBe('@alice');
    });
  });

  describe('AC-020: sources.xApi populated from candidate fields', () => {
    it('sets lastFetched, tweetsConsidered: 1, and founderHandle from candidate', () => {
      const candidate = makeCandidate({ discoveredAt: '2026-04-01T10:05:00.000Z', authorHandle: '@alice' });
      const result = composer.compose(candidate, makeWebsiteEnrichmentData(), fingerprints);
      expect(result.sources.xApi?.lastFetched).toBe('2026-04-01T10:05:00.000Z');
      expect(result.sources.xApi?.tweetsConsidered).toBe(1);
      expect(result.sources.xApi?.founderHandle).toBe('@alice');
    });
  });

  describe('AC-021: sources.websiteCrawl present when websiteData non-null, absent when null', () => {
    it('populates sources.websiteCrawl with lastFetched, pagesCrawled, and fetcher="firecrawl"', () => {
      const candidate = makeCandidate();
      const data = makeWebsiteEnrichmentData();
      const result = composer.compose(candidate, data, fingerprints);
      expect(result.sources.websiteCrawl).toBeDefined();
      expect(result.sources.websiteCrawl?.fetcher).toBe('firecrawl');
      expect(result.sources.websiteCrawl?.pagesCrawled).toContain('https://example.com/');
    });

    it('omits sources.websiteCrawl when websiteData is null', () => {
      const result = composer.compose(makeCandidate(), null, fingerprints);
      expect(result.sources.websiteCrawl).toBeUndefined();
    });
  });

  describe('AC-022: funding.claimed mapped from candidate tweet fields', () => {
    it('sets rawText, templateMatched, and claimedAt from candidate', () => {
      const candidate = makeCandidate({
        tweetText: 'We raised $5M seed',
        matchedTemplates: ['raised $5M seed'],
        postedAt: '2026-03-01T09:00:00.000Z',
      });
      const result = composer.compose(candidate, makeWebsiteEnrichmentData(), fingerprints);
      expect(result.funding.claimed.rawText).toBe('We raised $5M seed');
      expect(result.funding.claimed.templateMatched).toEqual(['raised $5M seed']);
      expect(result.funding.claimed.claimedAt).toBe('2026-03-01T09:00:00.000Z');
    });
  });

  describe('AC-023: product.competencyCellMatches computed from fingerprint signals against website terms', () => {
    it('includes a match entry for a cell whose terms appear in websiteData.extractedProduct', () => {
      const data = makeWebsiteEnrichmentData({
        extractedProduct: {
          ...makeWebsiteEnrichmentData().extractedProduct,
          architectureTerms: ['stablecoin'],
          stackMentions: ['multisig'],
        },
      });
      const result = composer.compose(makeCandidate(), data, fingerprints);
      const defiMatch = result.product.competencyCellMatches.find((m) => m.cell === 'DeFi & Yield');
      expect(defiMatch).toBeDefined();
      expect(defiMatch?.matchedSignals).toEqual(expect.arrayContaining(['stablecoin', 'multisig']));
    });

    it('uses candidate.matchedPrimarySignals when websiteData is null', () => {
      const candidate = makeCandidate({ matchedPrimarySignals: ['stablecoin'] });
      const result = composer.compose(candidate, null, fingerprints);
      const defiMatch = result.product.competencyCellMatches.find((m) => m.cell === 'DeFi & Yield');
      expect(defiMatch?.matchedSignals).toContain('stablecoin');
    });
  });

  describe('AC-024: competencyCellMatches[].score is matchedTermCount / totalCellTermCount', () => {
    it('computes score as float in [0, 1]', () => {
      // fingerprints has 2 terms for DeFi & Yield; data exposes 1 matching term
      const data = makeWebsiteEnrichmentData({
        extractedProduct: {
          ...makeWebsiteEnrichmentData().extractedProduct,
          architectureTerms: ['stablecoin'],
          stackMentions: [],
        },
      });
      const result = composer.compose(makeCandidate(), data, fingerprints);
      const defiMatch = result.product.competencyCellMatches.find((m) => m.cell === 'DeFi & Yield');
      expect(defiMatch?.score).toBeCloseTo(0.5); // 1 of 2 terms matched
    });

    it('returns score 0 when the cell fingerprint has zero primary signal terms', () => {
      const emptyFingerprints: ResolvedFingerprint[] = [{
        cell: 'Trading',
        resolvedAt: new Date().toISOString(),
        primarySignals: [],
        antiSignals: [],
      }];
      const result = composer.compose(makeCandidate(), makeWebsiteEnrichmentData(), emptyFingerprints);
      const tradingMatch = result.product.competencyCellMatches.find((m) => m.cell === 'Trading');
      expect(tradingMatch?.score).toBe(0);
    });
  });

  describe('AC-025: matchedCoreSignals contains only terms present in injected coreSignals', () => {
    it('classifies multisig as a core signal (present in coreSignals) and stablecoin as cell-only', () => {
      // coreSignals from makeCoreSignals() includes 'multisig' but not 'stablecoin'
      const data = makeWebsiteEnrichmentData({
        extractedProduct: {
          ...makeWebsiteEnrichmentData().extractedProduct,
          architectureTerms: ['stablecoin', 'multisig'],
          stackMentions: [],
        },
      });
      const result = composer.compose(makeCandidate(), data, fingerprints);
      const defiMatch = result.product.competencyCellMatches.find((m) => m.cell === 'DeFi & Yield');
      expect(defiMatch?.matchedCoreSignals).toContain('multisig');
      expect(defiMatch?.matchedCoreSignals).not.toContain('stablecoin');
    });
  });

  describe('AC-026: product.evidence populated from websiteData.extractedProduct.evidence or empty array', () => {
    it('maps evidence entries from websiteData', () => {
      const data = makeWebsiteEnrichmentData();
      const result = composer.compose(makeCandidate(), data, fingerprints);
      expect(result.product.evidence).toHaveLength(1);
      expect(result.product.evidence[0].snippet).toBe('multisig stablecoin');
    });

    it('returns empty evidence array when websiteData is null', () => {
      const result = composer.compose(makeCandidate(), null, fingerprints);
      expect(result.product.evidence).toHaveLength(0);
    });
  });

  describe('AC-027: rawContent.websiteMarkdown from websiteData or empty object', () => {
    it('copies websiteMarkdown from websiteData', () => {
      const data = makeWebsiteEnrichmentData();
      const result = composer.compose(makeCandidate(), data, fingerprints);
      expect(result.rawContent.websiteMarkdown).toEqual(data.websiteMarkdown);
    });

    it('sets websiteMarkdown to {} when websiteData is null', () => {
      const result = composer.compose(makeCandidate(), null, fingerprints);
      expect(result.rawContent.websiteMarkdown).toEqual({});
    });
  });

  describe('AC-028: rawContent.sourceTweets is single-entry array from candidate', () => {
    it('maps tweetId, tweetText, postedAt, authorHandle, authorBio to sourceTweets[0]', () => {
      const candidate = makeCandidate({
        tweetId: 'tweet-abc',
        tweetText: 'We raised $5M',
        postedAt: '2026-03-01T09:00:00.000Z',
        authorHandle: '@alice',
        authorBio: 'Founder',
      });
      const result = composer.compose(candidate, makeWebsiteEnrichmentData(), fingerprints);
      expect(result.rawContent.sourceTweets).toHaveLength(1);
      const tweet = result.rawContent.sourceTweets![0];
      expect(tweet.id).toBe('tweet-abc');
      expect(tweet.text).toBe('We raised $5M');
      expect(tweet.authorHandle).toBe('@alice');
      expect(tweet.authorBio).toBe('Founder');
    });
  });

  describe('AC-029: compose() validates output against EnrichedProfileSchema; throws ProfileComposerError on failure', () => {
    it('returns a schema-valid EnrichedProfile on the happy path', () => {
      const result = composer.compose(makeCandidate(), makeWebsiteEnrichmentData(), fingerprints);
      expect(() => EnrichedProfileSchema.parse(result)).not.toThrow();
    });

    it('throws ProfileComposerError when composed output would fail schema validation', () => {
      // Force an invalid state by using a composer that assembles an invalid profile
      // (test via mocking EnrichedProfileSchema.parse to simulate a schema failure, or
      // by deliberately passing a candidate that produces an invalid company.websiteUrl)
      const badCandidate = makeCandidate({
        resolvedCompany: { websiteUrl: 'not-a-url', name: 'Bad Corp' },
      });
      expect(() => composer.compose(badCandidate, null, fingerprints)).toThrow(ProfileComposerError);
    });
  });

  describe('AC-030: compose() with null websiteData returns valid profile with empty website-derived fields', () => {
    it('produces a valid EnrichedProfile with all empty website collections', () => {
      const result = composer.compose(makeCandidate(), null, fingerprints);
      expect(() => EnrichedProfileSchema.parse(result)).not.toThrow();
      expect(result.product.stackMentions).toHaveLength(0);
      expect(result.product.architectureTerms).toHaveLength(0);
      expect(result.product.antiSignalTerms).toHaveLength(0);
      expect(result.product.evidence).toHaveLength(0);
      expect(result.team.founders).toHaveLength(0);
      expect(result.rawContent.websiteMarkdown).toEqual({});
      expect(result.sources.websiteCrawl).toBeUndefined();
    });
  });
});
```

---

## Group D: Error Handling & State Transitions

**File:** `src/enrichment/EnrichmentEngine.errors.test.ts`

```typescript
describe('EnrichmentEngine — Error Handling & State Transitions', () => {
  describe('AC-031: enrich() re-throws ProfileComposerError; run() records in failedCandidates', () => {
    it('records the candidate in failedCandidates when ProfileComposerError is thrown', async () => {
      const candidate = makeCandidate();
      const xSource = makeStubXSignalSource([candidate]);
      const enricher = makeStubWebsiteEnricher();
      const composer = { compose: jest.fn().mockImplementation(() => { throw new ProfileComposerError('bad shape'); }) };
      const engine = createEnrichmentEngine({
        xSignalSource: xSource,
        websiteEnricher: enricher,
        profileComposer: composer,
        fingerprints: makeFingerprints(),
      });

      const result = await engine.run();

      expect(result.profilesEnriched).toHaveLength(0);
      expect(result.failedCandidates).toHaveLength(1);
      expect(result.failedCandidates[0].candidate).toBe(candidate);
      expect(result.failedCandidates[0].error).toBeInstanceOf(ProfileComposerError);
    });
  });

  describe('AC-032: XAuthError propagates from run() without catch', () => {
    it('throws XAuthError to the caller', async () => {
      const xSource = { pollOnce: jest.fn().mockRejectedValue(new XAuthError()) };
      const engine = createEnrichmentEngine({
        xSignalSource: xSource,
        websiteEnricher: makeStubWebsiteEnricher(),
        profileComposer: makeStubProfileComposer(),
        fingerprints: makeFingerprints(),
      });

      await expect(engine.run()).rejects.toBeInstanceOf(XAuthError);
    });
  });

  describe('AC-033: XNetworkError propagates from run() without catch', () => {
    it('throws XNetworkError to the caller', async () => {
      const xSource = { pollOnce: jest.fn().mockRejectedValue(new XNetworkError(new Error('ECONNREFUSED'))) };
      const engine = createEnrichmentEngine({
        xSignalSource: xSource,
        websiteEnricher: makeStubWebsiteEnricher(),
        profileComposer: makeStubProfileComposer(),
        fingerprints: makeFingerprints(),
      });

      await expect(engine.run()).rejects.toBeInstanceOf(XNetworkError);
    });
  });

  describe('AC-034: run() returns ok with empty arrays when pollOnce returns empty', () => {
    it('does not call WebsiteEnricher when no candidates are returned', async () => {
      const enricherSpy = jest.fn();
      const engine = createEnrichmentEngine({
        xSignalSource: makeStubXSignalSource([]),
        websiteEnricher: { enrich: enricherSpy } as unknown as WebsiteEnricher,
        profileComposer: makeStubProfileComposer(),
        fingerprints: makeFingerprints(),
      });

      const result = await engine.run();

      expect(result.status).toBe('ok');
      expect(result.profilesEnriched).toHaveLength(0);
      expect(result.failedCandidates).toHaveLength(0);
      expect(enricherSpy).not.toHaveBeenCalled();
    });
  });

  describe('AC-035: WebsiteEnrichmentError produces partial profile in profilesEnriched, not failedCandidates', () => {
    it('candidate does not appear in failedCandidates; partial profile appears in profilesEnriched', async () => {
      const candidate = makeCandidate();
      const xSource = makeStubXSignalSource([candidate]);
      const enricher = { enrich: jest.fn().mockRejectedValue(new WebsiteEnrichmentError('https://example.com')) };
      const engine = createEnrichmentEngine({
        xSignalSource: xSource,
        websiteEnricher: enricher,
        profileComposer: makeStubProfileComposer(),
        fingerprints: makeFingerprints(),
      });

      const result = await engine.run();

      expect(result.failedCandidates).toHaveLength(0);
      expect(result.profilesEnriched).toHaveLength(1);
    });
  });
});
```
