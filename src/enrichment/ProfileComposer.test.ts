import {
  makeCandidate,
  makeWebsiteEnrichmentData,
  makeFingerprints,
  makeCoreSignals,
  createProfileComposer,
  ProfileComposerError,
} from './__fixtures__/factories';
import type { ProfileComposer } from './__fixtures__/factories';
import type { ResolvedFingerprint, Signal } from '../fingerprint/schemas';
import { EnrichedProfileSchema } from '../schema/enrichedProfile';

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

    it('throws ProfileComposerError when resolvedCompany.name absent and handle is blank', () => {
      const candidate = makeCandidate({
        authorHandle: '@',
        resolvedCompany: { websiteUrl: 'https://example.com' },
      });
      expect(() => composer.compose(candidate, null, fingerprints)).toThrow(ProfileComposerError);
    });
  });

  describe('AC-018: company.normalizedName is lowercase whitespace-normalized', () => {
    it('lowercases and collapses whitespace', () => {
      const candidate = makeCandidate({
        resolvedCompany: { websiteUrl: 'https://example.com', name: '  Acme  Corp  ' },
      });
      const result = composer.compose(candidate, makeWebsiteEnrichmentData(), fingerprints);
      expect(result.company.normalizedName).toBe('acme corp');
    });
  });

  describe('AC-019: company.websiteUrl from resolvedCompany; xHandle from authorHandle', () => {
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
    it('sets lastFetched, tweetsConsidered: 1, and founderHandle', () => {
      const candidate = makeCandidate({
        discoveredAt: '2026-04-01T10:05:00.000Z',
        authorHandle: '@alice',
      });
      const result = composer.compose(candidate, makeWebsiteEnrichmentData(), fingerprints);
      expect(result.sources.xApi?.lastFetched).toBe('2026-04-01T10:05:00.000Z');
      expect(result.sources.xApi?.tweetsConsidered).toBe(1);
      expect(result.sources.xApi?.founderHandle).toBe('@alice');
    });
  });

  describe('AC-021: sources.websiteCrawl present when websiteData non-null; absent when null', () => {
    it('populates websiteCrawl with lastFetched, pagesCrawled, fetcher=firecrawl', () => {
      const data = makeWebsiteEnrichmentData();
      const result = composer.compose(makeCandidate(), data, fingerprints);
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
    it('sets rawText, templateMatched, and claimedAt', () => {
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

  describe('AC-023: product.competencyCellMatches computed from fingerprint signals', () => {
    it('includes DeFi match when architectureTerms+stackMentions contain fingerprint terms', () => {
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
    it('computes score as float in [0,1]', () => {
      const data = makeWebsiteEnrichmentData({
        extractedProduct: {
          ...makeWebsiteEnrichmentData().extractedProduct,
          architectureTerms: ['stablecoin'],
          stackMentions: [],
        },
      });
      const result = composer.compose(makeCandidate(), data, fingerprints);
      const defiMatch = result.product.competencyCellMatches.find((m) => m.cell === 'DeFi & Yield');
      expect(defiMatch?.score).toBeCloseTo(0.5);
    });

    it('returns score 0 when fingerprint has zero primary signal terms', () => {
      const emptyFp: ResolvedFingerprint[] = [{
        cell: 'Trading',
        resolvedAt: new Date().toISOString(),
        primarySignals: [],
        antiSignals: [],
      }];
      const result = composer.compose(makeCandidate(), makeWebsiteEnrichmentData(), emptyFp);
      const match = result.product.competencyCellMatches.find((m) => m.cell === 'Trading');
      expect(match?.score).toBe(0);
    });
  });

  describe('AC-025: matchedCoreSignals contains only coreSignals terms', () => {
    it('classifies multisig as core and stablecoin as cell-only', () => {
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

  describe('AC-026: product.evidence from websiteData or empty', () => {
    it('maps evidence entries from websiteData', () => {
      const result = composer.compose(makeCandidate(), makeWebsiteEnrichmentData(), fingerprints);
      expect(result.product.evidence).toHaveLength(1);
      expect(result.product.evidence[0].snippet).toBe('multisig stablecoin');
    });

    it('returns empty evidence when websiteData is null', () => {
      const result = composer.compose(makeCandidate(), null, fingerprints);
      expect(result.product.evidence).toHaveLength(0);
    });
  });

  describe('AC-027: rawContent.websiteMarkdown from websiteData or {}', () => {
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

  describe('AC-028: rawContent.sourceTweets is single-entry from candidate', () => {
    it('maps tweetId, tweetText, postedAt, authorHandle, authorBio', () => {
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

  describe('AC-029: compose() validates output; throws ProfileComposerError on failure', () => {
    it('returns a schema-valid EnrichedProfile on happy path', () => {
      const result = composer.compose(makeCandidate(), makeWebsiteEnrichmentData(), fingerprints);
      expect(() => EnrichedProfileSchema.parse(result)).not.toThrow();
    });

    it('throws ProfileComposerError when assembled profile would fail schema validation', () => {
      const badCandidate = makeCandidate({
        resolvedCompany: { websiteUrl: 'not-a-url', name: 'Bad Corp' },
      });
      expect(() => composer.compose(badCandidate, null, fingerprints)).toThrow(ProfileComposerError);
    });
  });

  describe('AC-030: compose() with null websiteData returns valid profile with empty collections', () => {
    it('produces valid EnrichedProfile with all empty website-derived fields', () => {
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
