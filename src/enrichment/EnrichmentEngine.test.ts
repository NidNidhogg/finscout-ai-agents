import { XRateLimitError as _XRateLimitError } from './x-signal/XSignalSource';
import {
  makeCandidate,
  makeFetchedPage,
  makeWebsiteEnrichmentData,
  makeStubXSignalSource,
  makeStubWebsiteEnricher,
  makeStubProfileComposer,
  buildMinimalProfile,
  makeFingerprints,
  createEnrichmentEngine,
  WebsiteEnrichmentError,
  ProfileComposerError,
} from './__fixtures__/factories';
import type { WebsiteEnricher, EnrichmentEngineDeps } from './__fixtures__/factories';

describe('EnrichmentEngine — Orchestrator Flow', () => {
  describe('AC-001: createEnrichmentEngine accepts injected dependencies', () => {
    it('constructs without error given stub dependencies', () => {
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
      expect(composer.compose).toHaveBeenCalledWith(candidate, websiteData, expect.any(Array));
    });
  });

  describe('AC-003: enrich() catches WebsiteEnrichmentError and calls compose with null', () => {
    it('returns partial EnrichedProfile without re-throwing', async () => {
      const candidate = makeCandidate();
      const enricher = {
        enrich: jest.fn().mockRejectedValue(new WebsiteEnrichmentError('https://example.com')),
      };
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
    it('calls websiteEnricher.enrich once per candidate', async () => {
      const candidates = [
        makeCandidate(),
        makeCandidate({ tweetId: 'tweet-002', resolvedCompany: { websiteUrl: 'https://other.com' } }),
      ];
      const xSource = makeStubXSignalSource(candidates);
      const enrichSpy = jest.fn().mockResolvedValue(makeWebsiteEnrichmentData());
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
    it('calls enrich only once for two candidates with the same websiteUrl', async () => {
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
      const xSource = { pollOnce: jest.fn().mockRejectedValue(new _XRateLimitError(30000)) };
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
      const enricherSpy = jest.fn().mockImplementation(async (url: string) => {
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
      const engine = createEnrichmentEngine({
        xSignalSource: makeStubXSignalSource([makeCandidate()]),
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
