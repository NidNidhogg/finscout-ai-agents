import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import type { EnrichedProfile, ReviewAnnotation } from '../../schema/enrichedProfile';
import type { ReviewedRecord } from '../types';

export function makeProfile(overrides: Partial<EnrichedProfile> = {}): EnrichedProfile {
  const id = overrides.id ?? randomUUID();
  return {
    id,
    enrichedAt: new Date().toISOString(),
    schemaVersion: '1.0.0',
    sources: {},
    company: {
      name: 'Acme DeFi',
      normalizedName: 'acme defi',
      websiteUrl: 'https://acme.fi',
    },
    funding: {
      claimed: {},
    },
    product: {
      stackMentions: [],
      architectureTerms: [],
      antiSignalTerms: [],
      competencyCellMatches: [],
      evidence: [],
    },
    team: {
      founders: [],
    },
    rawContent: {
      websiteMarkdown: {},
    },
    ...overrides,
  };
}

export function makeAnnotation(
  profileId: string,
  overrides: Partial<ReviewAnnotation> = {},
): ReviewAnnotation {
  return {
    profileId,
    reviewedAt: new Date().toISOString(),
    reviewedBy: 'dmitriy',
    profileAdequate: true,
    missingEvidenceTypes: [],
    tier: 'A',
    tierReason: 'Strong DeFi signals with multi-cell match.',
    crunchbaseCheck: {
      checked: true,
      foundInCrunchbase: false,
    },
    ...overrides,
  };
}

export function makeInadequateAnnotation(
  profileId: string,
  overrides: Partial<ReviewAnnotation> = {},
): ReviewAnnotation {
  return makeAnnotation(profileId, {
    profileAdequate: false,
    missingEvidenceTypes: ['missing_tech_stack'],
    tier: 'C',
    tierReason: 'Insufficient product signals.',
    ...overrides,
  });
}

export function makeReviewedRecord(
  profileIdOrProfile?: string | EnrichedProfile,
  annotationOverrides: Partial<ReviewAnnotation> = {},
): ReviewedRecord {
  const profile =
    typeof profileIdOrProfile === 'object' && profileIdOrProfile !== null
      ? profileIdOrProfile
      : makeProfile({ id: profileIdOrProfile ?? randomUUID() });
  return {
    profile,
    annotation: makeAnnotation(profile.id, annotationOverrides),
  };
}

export function makeInadequateReviewedRecord(
  profileIdOrProfile?: string | EnrichedProfile,
  annotationOverrides: Partial<ReviewAnnotation> = {},
): ReviewedRecord {
  return makeReviewedRecord(profileIdOrProfile, {
    profileAdequate: false,
    missingEvidenceTypes: ['missing_tech_stack'],
    tier: 'C',
    tierReason: 'Insufficient product signals.',
    ...annotationOverrides,
  });
}

export function makeInMemoryDb(): Database.Database {
  return new Database(':memory:');
}
