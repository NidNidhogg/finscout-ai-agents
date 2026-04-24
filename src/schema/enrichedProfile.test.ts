import { z } from 'zod';
import {
  EnrichedProfileSchema,
  ReviewAnnotationSchema,
} from './enrichedProfile';

// ── Helpers ───────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeProfile(overrides: any = {}): unknown {
  return {
    id: '123e4567-e89b-12d3-a456-426614174000',
    enrichedAt: '2026-04-22T00:00:00.000Z',
    schemaVersion: '1.0.0',
    sources: {},
    company: { name: 'Acme DeFi', normalizedName: 'acme-defi', websiteUrl: 'https://acmedefi.io' },
    funding: { claimed: {} },
    product: { stackMentions: [], architectureTerms: [], antiSignalTerms: [], competencyCellMatches: [], evidence: [] },
    team: { founders: [] },
    rawContent: { websiteMarkdown: {} },
    ...overrides,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeAnnotation(overrides: any = {}): unknown {
  return {
    profileId: '123e4567-e89b-12d3-a456-426614174000',
    reviewedAt: '2026-04-22T00:00:00.000Z',
    reviewedBy: 'analyst-1',
    profileAdequate: true,
    missingEvidenceTypes: [],
    tier: 'A',
    tierReason: 'Strong DeFi signal',
    crunchbaseCheck: { checked: false },
    ...overrides,
  };
}

// ── EnrichedProfile — id, enrichedAt, schemaVersion ──────────────────────────

describe('EnrichedProfile — id, enrichedAt, schemaVersion', () => {
  test('AC-001: EnrichedProfile parses successfully with a valid UUID id', () => {
    const result = EnrichedProfileSchema.parse(makeProfile({ id: '123e4567-e89b-12d3-a456-426614174000' }));
    expect(result.id).toBe('123e4567-e89b-12d3-a456-426614174000');
  });

  test('AC-002: EnrichedProfile fails validation when id is not a valid UUID', () => {
    expect(() => EnrichedProfileSchema.parse(makeProfile({ id: 'not-a-uuid' }))).toThrow(z.ZodError);
  });

  test('AC-003: EnrichedProfile parses successfully with a valid ISO 8601 enrichedAt', () => {
    const result = EnrichedProfileSchema.parse(makeProfile({ enrichedAt: '2026-04-22T00:00:00.000Z' }));
    expect(result.enrichedAt).toBe('2026-04-22T00:00:00.000Z');
  });

  test('AC-004: EnrichedProfile fails validation when enrichedAt is not a valid ISO 8601 datetime', () => {
    expect(() => EnrichedProfileSchema.parse(makeProfile({ enrichedAt: 'not-a-date' }))).toThrow(z.ZodError);
  });

  test('AC-005: EnrichedProfile parses successfully when schemaVersion is "1.0.0"', () => {
    const result = EnrichedProfileSchema.parse(makeProfile({ schemaVersion: '1.0.0' }));
    expect(result.schemaVersion).toBe('1.0.0');
  });

  test('AC-006: EnrichedProfile fails validation when schemaVersion is not "1.0.0"', () => {
    expect(() => EnrichedProfileSchema.parse(makeProfile({ schemaVersion: '2.0.0' }))).toThrow(z.ZodError);
    expect(() => EnrichedProfileSchema.parse(makeProfile({ schemaVersion: '1.0' }))).toThrow(z.ZodError);
  });
});

// ── EnrichedProfile — sources ─────────────────────────────────────────────────

describe('EnrichedProfile — sources', () => {
  test('AC-007: EnrichedProfile parses successfully with sources as an empty object', () => {
    const result = EnrichedProfileSchema.parse(makeProfile({ sources: {} }));
    expect(result.sources).toEqual({});
  });

  test('AC-008: EnrichedProfile parses successfully with a fully populated sources.xApi object', () => {
    const result = EnrichedProfileSchema.parse(makeProfile({
      sources: { xApi: { lastFetched: '2026-04-22T00:00:00.000Z', tweetsConsidered: 12, founderHandle: '@alice' } },
    }));
    expect(result.sources.xApi!.tweetsConsidered).toBe(12);
    expect(result.sources.xApi!.founderHandle).toBe('@alice');
  });

  test('AC-009: EnrichedProfile fails validation when sources.xApi.tweetsConsidered is negative', () => {
    expect(() => EnrichedProfileSchema.parse(makeProfile({
      sources: { xApi: { lastFetched: '2026-04-22T00:00:00.000Z', tweetsConsidered: -1 } },
    }))).toThrow(z.ZodError);
  });

  test('AC-010: EnrichedProfile parses successfully with a fully populated sources.websiteCrawl object', () => {
    const result = EnrichedProfileSchema.parse(makeProfile({
      sources: { websiteCrawl: { lastFetched: '2026-04-22T00:00:00.000Z', pagesCrawled: ['https://acmedefi.io/about'], fetcher: 'firecrawl' } },
    }));
    expect(result.sources.websiteCrawl!.fetcher).toBe('firecrawl');
    expect(result.sources.websiteCrawl!.pagesCrawled).toHaveLength(1);
  });

  test('AC-011: EnrichedProfile fails validation when a sources.websiteCrawl.pagesCrawled entry is not a valid URL', () => {
    expect(() => EnrichedProfileSchema.parse(makeProfile({
      sources: { websiteCrawl: { lastFetched: '2026-04-22T00:00:00.000Z', pagesCrawled: ['not-a-url'], fetcher: 'firecrawl' } },
    }))).toThrow(z.ZodError);
  });
});

// ── EnrichedProfile — company ─────────────────────────────────────────────────

describe('EnrichedProfile — company', () => {
  test('AC-012: EnrichedProfile fails validation when company.name is an empty string', () => {
    expect(() => EnrichedProfileSchema.parse(makeProfile({
      company: { name: '', normalizedName: 'acme-defi', websiteUrl: 'https://acmedefi.io' },
    }))).toThrow(z.ZodError);
  });

  test('AC-013: EnrichedProfile fails validation when company.websiteUrl is not a valid URL', () => {
    expect(() => EnrichedProfileSchema.parse(makeProfile({
      company: { name: 'Acme DeFi', normalizedName: 'acme-defi', websiteUrl: 'not-a-url' },
    }))).toThrow(z.ZodError);
  });

  test('AC-014: EnrichedProfile fails validation when company.linkedinUrl is present but not a valid URL', () => {
    expect(() => EnrichedProfileSchema.parse(makeProfile({
      company: { name: 'Acme DeFi', normalizedName: 'acme-defi', websiteUrl: 'https://acmedefi.io', linkedinUrl: 'not-a-url' },
    }))).toThrow(z.ZodError);
  });
});

// ── EnrichedProfile — funding ─────────────────────────────────────────────────

describe('EnrichedProfile — funding', () => {
  test('AC-015: EnrichedProfile parses successfully when funding.claimed has all optional fields omitted', () => {
    const result = EnrichedProfileSchema.parse(makeProfile({ funding: { claimed: {} } }));
    expect(result.funding.claimed).toEqual({});
    expect(result.funding.confirmed).toBeUndefined();
  });

  test('AC-016: EnrichedProfile fails validation when funding.claimed.amountUSD is zero or negative', () => {
    expect(() => EnrichedProfileSchema.parse(makeProfile({ funding: { claimed: { amountUSD: 0 } } }))).toThrow(z.ZodError);
    expect(() => EnrichedProfileSchema.parse(makeProfile({ funding: { claimed: { amountUSD: -1000 } } }))).toThrow(z.ZodError);
  });

  test('AC-017: EnrichedProfile fails validation when funding.claimed.stage is not a valid FundingStage value', () => {
    expect(() => EnrichedProfileSchema.parse(makeProfile({ funding: { claimed: { stage: 'series-z' } } }))).toThrow(z.ZodError);
  });

  test('AC-018: EnrichedProfile parses successfully when funding.confirmed is present with foundInCrunchbase as a boolean', () => {
    const result = EnrichedProfileSchema.parse(makeProfile({
      funding: { claimed: {}, confirmed: { foundInCrunchbase: true } },
    }));
    expect(result.funding.confirmed!.foundInCrunchbase).toBe(true);
  });

  test('AC-019: EnrichedProfile fails validation when funding.confirmed.leadTimeDays is negative', () => {
    expect(() => EnrichedProfileSchema.parse(makeProfile({
      funding: { claimed: {}, confirmed: { foundInCrunchbase: false, leadTimeDays: -5 } },
    }))).toThrow(z.ZodError);
  });
});

// ── EnrichedProfile — product ─────────────────────────────────────────────────

describe('EnrichedProfile — product', () => {
  test('AC-020: EnrichedProfile fails validation when a competencyCellMatches entry has an invalid cell value', () => {
    expect(() => EnrichedProfileSchema.parse(makeProfile({
      product: { stackMentions: [], architectureTerms: [], antiSignalTerms: [], evidence: [],
        competencyCellMatches: [{ cell: 'InvalidCell', matchedSignals: [], matchedCoreSignals: [], score: 0.5 }] },
    }))).toThrow(z.ZodError);
  });

  test('AC-021: EnrichedProfile fails validation when a competencyCellMatches entry has a score outside [0, 1]', () => {
    expect(() => EnrichedProfileSchema.parse(makeProfile({
      product: { stackMentions: [], architectureTerms: [], antiSignalTerms: [], evidence: [],
        competencyCellMatches: [{ cell: 'DeFi & Yield', matchedSignals: [], matchedCoreSignals: [], score: 1.5 }] },
    }))).toThrow(z.ZodError);
    expect(() => EnrichedProfileSchema.parse(makeProfile({
      product: { stackMentions: [], architectureTerms: [], antiSignalTerms: [], evidence: [],
        competencyCellMatches: [{ cell: 'DeFi & Yield', matchedSignals: [], matchedCoreSignals: [], score: -0.1 }] },
    }))).toThrow(z.ZodError);
  });

  test('AC-022: EnrichedProfile fails validation when a product.evidence entry has an invalid relevance value', () => {
    expect(() => EnrichedProfileSchema.parse(makeProfile({
      product: { stackMentions: [], architectureTerms: [], antiSignalTerms: [], competencyCellMatches: [],
        evidence: [{ page: 'https://acmedefi.io', snippet: 'test', relevance: 'critical' }] },
    }))).toThrow(z.ZodError);
  });

  test('AC-023: EnrichedProfile fails validation when a product.evidence entry has a non-URL page value', () => {
    expect(() => EnrichedProfileSchema.parse(makeProfile({
      product: { stackMentions: [], architectureTerms: [], antiSignalTerms: [], competencyCellMatches: [],
        evidence: [{ page: 'not-a-url', snippet: 'test', relevance: 'high' }] },
    }))).toThrow(z.ZodError);
  });
});

// ── EnrichedProfile — team ────────────────────────────────────────────────────

describe('EnrichedProfile — team', () => {
  test('AC-024: EnrichedProfile parses successfully when team.founders is an empty array', () => {
    const result = EnrichedProfileSchema.parse(makeProfile({ team: { founders: [] } }));
    expect(result.team.founders).toHaveLength(0);
  });

  test('AC-025: EnrichedProfile fails validation when a team.openRoles entry has an empty string title', () => {
    expect(() => EnrichedProfileSchema.parse(makeProfile({
      team: { founders: [], openRoles: [{ title: '', stackHints: [] }] },
    }))).toThrow(z.ZodError);
  });

  test('AC-026: EnrichedProfile fails validation when a team.openRoles entry has an invalid seniority value', () => {
    expect(() => EnrichedProfileSchema.parse(makeProfile({
      team: { founders: [], openRoles: [{ title: 'Engineer', stackHints: [], seniority: 'principal' }] },
    }))).toThrow(z.ZodError);
  });
});

// ── EnrichedProfile — rawContent ──────────────────────────────────────────────

describe('EnrichedProfile — rawContent', () => {
  test('AC-027: EnrichedProfile parses successfully when rawContent.websiteMarkdown is an empty record', () => {
    const result = EnrichedProfileSchema.parse(makeProfile({ rawContent: { websiteMarkdown: {} } }));
    expect(result.rawContent.websiteMarkdown).toEqual({});
    expect(result.rawContent.sourceTweets).toBeUndefined();
  });

  test('AC-028: EnrichedProfile fails validation when a rawContent.sourceTweets entry has an empty string id', () => {
    expect(() => EnrichedProfileSchema.parse(makeProfile({
      rawContent: { websiteMarkdown: {}, sourceTweets: [{ id: '', text: 'hello', postedAt: '2026-04-22T00:00:00.000Z', authorHandle: '@alice' }] },
    }))).toThrow(z.ZodError);
  });

  test('AC-029: EnrichedProfile fails validation when a rawContent.sourceTweets entry has a non-ISO-8601 postedAt value', () => {
    expect(() => EnrichedProfileSchema.parse(makeProfile({
      rawContent: { websiteMarkdown: {}, sourceTweets: [{ id: '1', text: 'hello', postedAt: 'yesterday', authorHandle: '@alice' }] },
    }))).toThrow(z.ZodError);
  });
});

// ── ReviewAnnotation — core fields ────────────────────────────────────────────

describe('ReviewAnnotation — core fields', () => {
  test('AC-030: ReviewAnnotation fails validation when profileId is not a valid UUID', () => {
    expect(() => ReviewAnnotationSchema.parse(makeAnnotation({ profileId: 'not-a-uuid' }))).toThrow(z.ZodError);
  });

  test('AC-031: ReviewAnnotation fails validation when reviewedBy is an empty string', () => {
    expect(() => ReviewAnnotationSchema.parse(makeAnnotation({ reviewedBy: '' }))).toThrow(z.ZodError);
  });

  test('AC-032: ReviewAnnotation fails validation when tier is not in ["A", "B", "C"]', () => {
    expect(() => ReviewAnnotationSchema.parse(makeAnnotation({ tier: 'D' }))).toThrow(z.ZodError);
  });

  test('AC-033: ReviewAnnotation fails validation when tierReason is an empty string', () => {
    expect(() => ReviewAnnotationSchema.parse(makeAnnotation({ tierReason: '' }))).toThrow(z.ZodError);
  });
});

// ── ReviewAnnotation — adequacy conditional invariant ─────────────────────────

describe('ReviewAnnotation — adequacy conditional invariant', () => {
  test('AC-034: ReviewAnnotation parses successfully when profileAdequate=false and missingEvidenceTypes is non-empty', () => {
    const result = ReviewAnnotationSchema.parse(
      makeAnnotation({ profileAdequate: false, missingEvidenceTypes: ['missing_tech_stack'] }),
    );
    expect(result.profileAdequate).toBe(false);
    expect(result.missingEvidenceTypes).toContain('missing_tech_stack');
  });

  test('AC-035: ReviewAnnotation fails validation when profileAdequate=false and missingEvidenceTypes is empty', () => {
    const result = ReviewAnnotationSchema.safeParse(
      makeAnnotation({ profileAdequate: false, missingEvidenceTypes: [] }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('missingEvidenceTypes'))).toBe(true);
    }
  });

  test('AC-036: ReviewAnnotation parses successfully when profileAdequate=true and missingEvidenceTypes is empty', () => {
    const result = ReviewAnnotationSchema.parse(
      makeAnnotation({ profileAdequate: true, missingEvidenceTypes: [] }),
    );
    expect(result.profileAdequate).toBe(true);
    expect(result.missingEvidenceTypes).toHaveLength(0);
  });

  test('AC-037: ReviewAnnotation fails validation when profileAdequate=true and missingEvidenceTypes is non-empty', () => {
    const result = ReviewAnnotationSchema.safeParse(
      makeAnnotation({ profileAdequate: true, missingEvidenceTypes: ['noise_false_positive'] }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('missingEvidenceTypes'))).toBe(true);
    }
  });
});
