import { formatExportRecord } from './review-export';
import type { QueueItem } from '../review-queue/types';

function makeQueueItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    status: 'reviewed',
    enqueuedAt: '2026-04-25T00:00:00.000Z',
    reviewedAt: '2026-04-26T00:00:00.000Z',
    profile: {
      id: '11111111-1111-1111-1111-111111111111',
      enrichedAt: '2026-04-25T00:00:00.000Z',
      schemaVersion: '1.0.0',
      sources: {},
      company: {
        name: 'AcmeDeFi',
        normalizedName: 'acmedefi',
        websiteUrl: 'https://acmedefi.io',
        xHandle: '@acmedefi',
      },
      funding: {
        claimed: { rawText: 'raised $5M seed' },
      },
      product: {
        stackMentions: ['Rust'],
        architectureTerms: ['multisig'],
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
    },
    annotation: {
      profileId: '11111111-1111-1111-1111-111111111111',
      reviewedAt: '2026-04-26T00:00:00.000Z',
      reviewedBy: 'analyst@example.com',
      profileAdequate: true,
      missingEvidenceTypes: [],
      tier: 'A',
      tierReason: 'Strong DeFi signals',
      crunchbaseCheck: { checked: true, foundInCrunchbase: false },
    },
    ...overrides,
  };
}

describe('formatExportRecord', () => {
  it('maps id and company fields', () => {
    const record = formatExportRecord(makeQueueItem());
    expect(record.id).toBe('11111111-1111-1111-1111-111111111111');
    expect(record.company).toBe('AcmeDeFi');
    expect(record.websiteUrl).toBe('https://acmedefi.io');
  });

  it('maps annotation fields', () => {
    const record = formatExportRecord(makeQueueItem());
    expect(record.tier).toBe('A');
    expect(record.profileAdequate).toBe(true);
    expect(record.missingEvidenceTypes).toEqual([]);
    expect(record.tierReason).toBe('Strong DeFi signals');
  });

  it('preserves enqueuedAt and reviewedAt', () => {
    const record = formatExportRecord(makeQueueItem());
    expect(record.enqueuedAt).toBe('2026-04-25T00:00:00.000Z');
    expect(record.reviewedAt).toBe('2026-04-26T00:00:00.000Z');
  });

  it('maps reviewerNote when present', () => {
    const item = makeQueueItem();
    item.annotation!.reviewerNote = 'Looks great';
    const record = formatExportRecord(item);
    expect(record.reviewerNote).toBe('Looks great');
  });

  it('leaves reviewerNote undefined when absent', () => {
    const record = formatExportRecord(makeQueueItem());
    expect(record.reviewerNote).toBeUndefined();
  });

  it('maps missingEvidenceTypes for inadequate profiles', () => {
    const item = makeQueueItem();
    item.annotation!.profileAdequate = false;
    item.annotation!.missingEvidenceTypes = ['missing_tech_stack', 'noise_false_positive'];
    const record = formatExportRecord(item);
    expect(record.missingEvidenceTypes).toEqual(['missing_tech_stack', 'noise_false_positive']);
  });
});
