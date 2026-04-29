import {
  makeCandidate,
  makeStubXSignalSource,
  makeStubWebsiteEnricher,
  makeStubProfileComposer,
  makeFingerprints,
  createEnrichmentEngine,
  WebsiteEnrichmentError,
  ProfileComposerError,
} from './__fixtures__/factories';
import type { WebsiteEnricher } from './__fixtures__/factories';
import { XAuthError, XNetworkError } from './x-signal/XSignalSource';

describe('EnrichmentEngine — Error Handling & State Transitions', () => {
  describe('AC-031: enrich() re-throws ProfileComposerError; run() records in failedCandidates', () => {
    it('records the candidate in failedCandidates when compose throws', async () => {
      const candidate = makeCandidate();
      const xSource = makeStubXSignalSource([candidate]);
      const enricher = makeStubWebsiteEnricher();
      const composer = {
        compose: jest.fn().mockImplementation(() => {
          throw new ProfileComposerError('bad shape');
        }),
      };
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
      const xSource = {
        pollOnce: jest.fn().mockRejectedValue(new XNetworkError(new Error('ECONNREFUSED'))),
      };
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
    it('does not call WebsiteEnricher when no candidates returned', async () => {
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

  describe('AC-035: WebsiteEnrichmentError produces partial profile; not in failedCandidates', () => {
    it('partial profile in profilesEnriched; failedCandidates empty', async () => {
      const candidate = makeCandidate();
      const xSource = makeStubXSignalSource([candidate]);
      const enricher = {
        enrich: jest.fn().mockRejectedValue(new WebsiteEnrichmentError('https://example.com')),
      };
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
