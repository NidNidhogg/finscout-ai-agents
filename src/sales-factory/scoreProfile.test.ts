import { randomUUID } from 'crypto';
import { EnrichedProfileSchema } from '../schema/enrichedProfile';
import type { EnrichedProfile } from '../schema/enrichedProfile';
import { scoreProfile } from './scoreProfile';

const TODAY = new Date('2026-05-20T00:00:00.000Z');

beforeAll(() => {
  jest.useFakeTimers();
  jest.setSystemTime(TODAY);
});

afterAll(() => {
  jest.useRealTimers();
});

function daysAgo(days: number): string {
  return new Date(TODAY.getTime() - days * 24 * 60 * 60 * 1_000).toISOString();
}

function makeProfile(overrides: {
  rawText?: string;
  amountUSD?: number;
  claimedAt?: string;
  stackMentions?: string[];
  architectureTerms?: string[];
  antiSignalTerms?: string[];
}): EnrichedProfile {
  return EnrichedProfileSchema.parse({
    id: randomUUID(),
    enrichedAt: TODAY.toISOString(),
    schemaVersion: '1.0.0',
    sources: {},
    company: {
      name: 'TestCo',
      normalizedName: 'testco',
      websiteUrl: 'https://example.com',
    },
    funding: {
      claimed: {
        rawText: overrides.rawText ?? 'X-Radar: @testco just announced raising $5M in Seed.',
        ...(overrides.amountUSD !== undefined ? { amountUSD: overrides.amountUSD } : {}),
        ...(overrides.claimedAt !== undefined ? { claimedAt: overrides.claimedAt } : {}),
      },
    },
    product: {
      stackMentions: overrides.stackMentions ?? ['Rust', 'Solidity'],
      architectureTerms: overrides.architectureTerms ?? ['multisig', 'settlement'],
      antiSignalTerms: overrides.antiSignalTerms ?? [],
      competencyCellMatches: [],
      evidence: [],
    },
    team: { founders: [] },
    rawContent: { websiteMarkdown: {} },
  });
}

const GOOD_SIGNALS = {
  stackMentions: ['Rust', 'Solidity'],
  architectureTerms: ['multisig', 'settlement'],
};

// ── Tier A ────────────────────────────────────────────────────────────────────

describe('scoreProfile — Tier A', () => {
  test('fresh raise ≤120 days ($5M) → A', () => {
    const result = scoreProfile(makeProfile({ ...GOOD_SIGNALS, amountUSD: 5_000_000, claimedAt: daysAgo(60) }));
    expect(result.tier).toBe('A');
    expect(result.reason).toContain('60');
  });

  test('boundary: exactly 120 days → A', () => {
    const result = scoreProfile(makeProfile({ ...GOOD_SIGNALS, amountUSD: 5_000_000, claimedAt: daysAgo(120) }));
    expect(result.tier).toBe('A');
  });

  test('DefiLlama lead with tech signals → A regardless of no claimedAt', () => {
    const result = scoreProfile(makeProfile({
      rawText: 'DefiLlama TVL: $45.2M',
      stackMentions: ['Solidity'],
      architectureTerms: ['vault', 'amm'],
    }));
    expect(result.tier).toBe('A');
    expect(result.reason).toContain('DefiLlama');
  });

  test('DefiLlama bypasses temporal gate even with stale claimedAt', () => {
    const result = scoreProfile(makeProfile({
      rawText: 'DefiLlama TVL: $45.2M',
      claimedAt: daysAgo(500),
      stackMentions: ['Solidity'],
      architectureTerms: ['vault'],
    }));
    expect(result.tier).toBe('A');
  });

  test('raise of exactly $35M (upper boundary) → A (not overfunded)', () => {
    const result = scoreProfile(makeProfile({ ...GOOD_SIGNALS, amountUSD: 35_000_000, claimedAt: daysAgo(30) }));
    expect(result.tier).toBe('A');
  });
});

// ── Tier B ────────────────────────────────────────────────────────────────────

describe('scoreProfile — Tier B', () => {
  test('warm raise (150 days, $5M) → B', () => {
    const result = scoreProfile(makeProfile({ ...GOOD_SIGNALS, amountUSD: 5_000_000, claimedAt: daysAgo(150) }));
    expect(result.tier).toBe('B');
  });

  test('boundary: exactly 365 days → B (not yet stale)', () => {
    const result = scoreProfile(makeProfile({ ...GOOD_SIGNALS, amountUSD: 5_000_000, claimedAt: daysAgo(365) }));
    expect(result.tier).toBe('B');
  });

  test('no claimedAt but has tech signals → B (warm default, recency unverifiable)', () => {
    const result = scoreProfile(makeProfile({ ...GOOD_SIGNALS, amountUSD: 5_000_000 }));
    expect(result.tier).toBe('B');
    expect(result.reason).toContain('recency unverifiable');
  });
});

// ── Tier C: temporal ──────────────────────────────────────────────────────────

describe('scoreProfile — Tier C: stale funding', () => {
  test('366 days old → C', () => {
    const result = scoreProfile(makeProfile({ ...GOOD_SIGNALS, amountUSD: 5_000_000, claimedAt: daysAgo(366) }));
    expect(result.tier).toBe('C');
    expect(result.reason).toContain('stale');
  });

  test('2-year-old raise → C', () => {
    const result = scoreProfile(makeProfile({ ...GOOD_SIGNALS, amountUSD: 5_000_000, claimedAt: daysAgo(730) }));
    expect(result.tier).toBe('C');
  });
});

// ── Tier C: financial corridor ────────────────────────────────────────────────

describe('scoreProfile — Tier C: financial corridor', () => {
  test('$40M (overfunded) → C', () => {
    const result = scoreProfile(makeProfile({ ...GOOD_SIGNALS, amountUSD: 40_000_000, claimedAt: daysAgo(30) }));
    expect(result.tier).toBe('C');
    expect(result.reason).toContain('$35M');
  });

  test('$35_000_001 (just over cap) → C', () => {
    const result = scoreProfile(makeProfile({ ...GOOD_SIGNALS, amountUSD: 35_000_001, claimedAt: daysAgo(30) }));
    expect(result.tier).toBe('C');
  });

  test('$500k (underfunded) → C', () => {
    const result = scoreProfile(makeProfile({ ...GOOD_SIGNALS, amountUSD: 500_000, claimedAt: daysAgo(30) }));
    expect(result.tier).toBe('C');
    expect(result.reason).toContain('$1M');
  });

  test('$1M (at minimum) → not C', () => {
    const result = scoreProfile(makeProfile({ ...GOOD_SIGNALS, amountUSD: 1_000_000, claimedAt: daysAgo(30) }));
    expect(result.tier).not.toBe('C');
  });
});

// ── Tier C: signal quality ────────────────────────────────────────────────────

describe('scoreProfile — Tier C: signal quality', () => {
  test('no tech signals → C', () => {
    const result = scoreProfile(makeProfile({
      amountUSD: 5_000_000,
      claimedAt: daysAgo(30),
      stackMentions: [],
      architectureTerms: [],
    }));
    expect(result.tier).toBe('C');
    expect(result.reason).toContain('No technical signals');
  });

  test('anti-signal terms present → C', () => {
    const result = scoreProfile(makeProfile({
      ...GOOD_SIGNALS,
      amountUSD: 5_000_000,
      claimedAt: daysAgo(30),
      antiSignalTerms: ['outstaffing', 'dedicated teams'],
    }));
    expect(result.tier).toBe('C');
    expect(result.reason).toContain('Anti-signal');
  });

  test('anti-signals take priority over tech signals', () => {
    const result = scoreProfile(makeProfile({
      stackMentions: ['Rust'],
      architectureTerms: ['multisig'],
      antiSignalTerms: ['staff augmentation'],
      amountUSD: 5_000_000,
      claimedAt: daysAgo(30),
    }));
    expect(result.tier).toBe('C');
  });
});

// ── DefiLlama edge cases ──────────────────────────────────────────────────────

describe('scoreProfile — DefiLlama edge cases', () => {
  test('DefiLlama with NO tech signals → C (MVA complexity required)', () => {
    const result = scoreProfile(makeProfile({
      rawText: 'DefiLlama TVL: $45.2M',
      stackMentions: [],
      architectureTerms: [],
    }));
    expect(result.tier).toBe('C');
    expect(result.reason).toContain('No technical signals');
  });
});
