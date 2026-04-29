import { randomUUID } from 'crypto';
import type { CompanyCandidate } from '../x-signal/XSignalSource';
import type {
  FetchedPage,
  WebsiteEnrichmentData,
  WebsiteEnricher,
  ProfileComposer,
  EnrichmentEngineDeps,
} from '../EnrichmentEngine';
import type { ResolvedFingerprint, Signal } from '../../fingerprint/schemas';
import { EnrichedProfileSchema } from '../../schema/enrichedProfile';
import {
  XRateLimitError,
  XAuthError,
  XNetworkError,
} from '../x-signal/XSignalSource';
import {
  createEnrichmentEngine,
  createWebsiteEnricher,
  createProfileComposer,
  WebsiteEnrichmentError,
  ProfileComposerError,
  PageFetchTimeoutError,
  PageFetchNetworkError,
} from '../EnrichmentEngine';

export {
  XRateLimitError,
  XAuthError,
  XNetworkError,
  createEnrichmentEngine,
  createWebsiteEnricher,
  createProfileComposer,
  WebsiteEnrichmentError,
  ProfileComposerError,
  PageFetchTimeoutError,
  PageFetchNetworkError,
};
export type { FetchedPage, WebsiteEnrichmentData, WebsiteEnricher, ProfileComposer, EnrichmentEngineDeps };

export function makeCandidate(overrides: Partial<CompanyCandidate> = {}): CompanyCandidate {
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

export function makeFetchedPage(overrides: Partial<FetchedPage> = {}): FetchedPage {
  return {
    url: 'https://example.com/',
    markdown: '# Example Corp\nWe build multisig stablecoin infrastructure.',
    title: 'Example Corp',
    metadata: {},
    fetchedAt: new Date('2026-04-01T10:10:00.000Z'),
    ...overrides,
  };
}

export function makeWebsiteEnrichmentData(
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
    ...overrides,
  };
}

export function makeStubXSignalSource(candidates: CompanyCandidate[] = []) {
  return { pollOnce: jest.fn().mockResolvedValue(candidates) };
}

export function makeStubWebsiteEnricher(data: WebsiteEnrichmentData = makeWebsiteEnrichmentData()) {
  return { enrich: jest.fn().mockResolvedValue(data) };
}

export function makeStubProfileComposer(
  profile?: import('../../schema/enrichedProfile').EnrichedProfile,
) {
  const out = profile ?? buildMinimalProfile();
  return { compose: jest.fn().mockReturnValue(out) };
}

export function buildMinimalProfile() {
  return EnrichedProfileSchema.parse({
    id: randomUUID(),
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

export function makeFingerprints(): ResolvedFingerprint[] {
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

export function makeCoreSignals(): Signal[] {
  return [
    { term: 'multisig', weight: 1.2 },
    { term: 'audit', weight: 1.5 },
    { term: 'settlement finality', weight: 1.3 },
  ];
}
