import { qualifyLead, scoreLead, mapMVA, LeadInput } from './salesFactory';
import { ValidationError } from './errors';

// Fixed reference date matching project currentDate
const TODAY = new Date('2026-04-15T00:00:00.000Z');

function daysAgo(days: number): string {
  return new Date(TODAY.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

const VALID_BASE: LeadInput = {
  companyId: 'company-001',
  sector: 'Fintech',
  stage: 'Seed',
  lastFundedAt: daysAgo(90),
  headcount: 20,
  signals: [],
};

beforeAll(() => {
  jest.useFakeTimers();
  jest.setSystemTime(TODAY);
});

afterAll(() => {
  jest.useRealTimers();
});

// ── AC-001: Sector gate ──────────────────────────────────────────────────────

describe('qualifyLead — AC-001: Sector gate', () => {
  test('valid sector "Fintech" passes', () => {
    const result = qualifyLead({ ...VALID_BASE, sector: 'Fintech' });
    expect(result.status).toBe('QUALIFIED');
    expect(result.failedGate).toBeUndefined();
  });

  test('all six valid sectors pass', () => {
    const sectors = ['Fintech', 'Web3', 'Crypto', 'DeFi', 'Wallet', 'Stablecoin'];
    for (const sector of sectors) {
      const result = qualifyLead({ ...VALID_BASE, sector });
      expect(result.failedGate).not.toBe('SECTOR');
    }
  });

  test('case-insensitive: "fintech" passes', () => {
    const result = qualifyLead({ ...VALID_BASE, sector: 'fintech' });
    expect(result.status).toBe('QUALIFIED');
  });

  test('unknown sector "SaaS" is disqualified', () => {
    const result = qualifyLead({ ...VALID_BASE, sector: 'SaaS' });
    expect(result.status).toBe('DISQUALIFIED');
    expect(result.failedGate).toBe('SECTOR');
    expect(result.lead).toBeUndefined();
  });

  test('empty string sector is disqualified', () => {
    const result = qualifyLead({ ...VALID_BASE, sector: '' });
    expect(result.failedGate).toBe('SECTOR');
  });
});

// ── AC-002: Stage gate ───────────────────────────────────────────────────────

describe('qualifyLead — AC-002: Stage gate', () => {
  test('valid stage "Seed" passes', () => {
    const result = qualifyLead({ ...VALID_BASE, stage: 'Seed' });
    expect(result.status).toBe('QUALIFIED');
  });

  test('all valid stages pass', () => {
    for (const stage of ['Pre-Seed', 'Seed', 'Series A']) {
      const result = qualifyLead({ ...VALID_BASE, stage });
      expect(result.failedGate).not.toBe('STAGE');
    }
  });

  test('Series B is disqualified', () => {
    const result = qualifyLead({ ...VALID_BASE, stage: 'Series B' });
    expect(result.status).toBe('DISQUALIFIED');
    expect(result.failedGate).toBe('STAGE');
  });

  test('case-insensitive: "series a" passes', () => {
    const result = qualifyLead({ ...VALID_BASE, stage: 'series a' });
    expect(result.status).toBe('QUALIFIED');
  });
});

// ── AC-003: Funding Recency gate ─────────────────────────────────────────────

describe('qualifyLead — AC-003: Funding Recency gate', () => {
  test('funded 3 months ago (90 days) passes', () => {
    const result = qualifyLead({ ...VALID_BASE, lastFundedAt: daysAgo(90) });
    expect(result.status).toBe('QUALIFIED');
  });

  test('funded 13 months ago (395 days) is disqualified', () => {
    const result = qualifyLead({ ...VALID_BASE, lastFundedAt: daysAgo(395) });
    expect(result.status).toBe('DISQUALIFIED');
    expect(result.failedGate).toBe('FUNDING_RECENCY');
  });

  test('funded 2 weeks ago (14 days) is disqualified — too recent', () => {
    const result = qualifyLead({ ...VALID_BASE, lastFundedAt: daysAgo(14) });
    expect(result.status).toBe('DISQUALIFIED');
    expect(result.failedGate).toBe('FUNDING_RECENCY');
  });

  test('funded exactly 12 months ago (365 days) passes — boundary inclusive', () => {
    const result = qualifyLead({ ...VALID_BASE, lastFundedAt: daysAgo(365) });
    expect(result.status).toBe('QUALIFIED');
  });

  test('funded exactly 1 month ago (30 days) passes — boundary inclusive', () => {
    const result = qualifyLead({ ...VALID_BASE, lastFundedAt: daysAgo(30) });
    expect(result.status).toBe('QUALIFIED');
  });

  test('invalid date string throws ValidationError referencing lastFundedAt', () => {
    const fn = () => qualifyLead({ ...VALID_BASE, lastFundedAt: 'not-a-date' });
    expect(fn).toThrow(ValidationError);
    expect(fn).toThrow('lastFundedAt');
  });
});

// ── AC-004: Headcount gate ───────────────────────────────────────────────────

describe('qualifyLead — AC-004: Headcount gate', () => {
  test('headcount 50 passes', () => {
    const result = qualifyLead({ ...VALID_BASE, headcount: 50 });
    expect(result.status).toBe('QUALIFIED');
  });

  test('headcount 51 is disqualified', () => {
    const result = qualifyLead({ ...VALID_BASE, headcount: 51 });
    expect(result.status).toBe('DISQUALIFIED');
    expect(result.failedGate).toBe('HEADCOUNT');
  });

  test('headcount 1 passes', () => {
    const result = qualifyLead({ ...VALID_BASE, headcount: 1 });
    expect(result.status).toBe('QUALIFIED');
  });
});

// ── AC-005: Full qualification payload ───────────────────────────────────────

describe('qualifyLead — AC-005: Full qualification payload', () => {
  test('all gates pass returns QUALIFIED with full lead payload', () => {
    const input: LeadInput = {
      companyId: 'comp-abc',
      sector: 'Crypto',
      stage: 'Pre-Seed',
      lastFundedAt: daysAgo(180),
      headcount: 10,
      signals: [],
    };
    const result = qualifyLead(input);
    expect(result.status).toBe('QUALIFIED');
    expect(result.lead?.companyId).toBe('comp-abc');
    expect(result.failedGate).toBeUndefined();
  });
});

// ── AC-006..AC-011: Scoring ──────────────────────────────────────────────────

describe('scoreLead — AC-006..AC-011: Signal accumulation', () => {
  test('HIRING_TECH yields +40', () => {
    const result = scoreLead({ ...VALID_BASE, signals: [{ type: 'HIRING_TECH' }] });
    expect(result.score).toBe(40);
  });

  test('LPR yields +30', () => {
    const result = scoreLead({ ...VALID_BASE, signals: [{ type: 'LPR' }] });
    expect(result.score).toBe(30);
  });

  test('SECURITY yields +30', () => {
    const result = scoreLead({ ...VALID_BASE, signals: [{ type: 'SECURITY' }] });
    expect(result.score).toBe(30);
  });

  test('OUTSTAFFING yields -50', () => {
    const result = scoreLead({ ...VALID_BASE, signals: [{ type: 'OUTSTAFFING' }] });
    expect(result.score).toBe(-50);
  });

  test('no signals yields 0', () => {
    const result = scoreLead({ ...VALID_BASE, signals: [] });
    expect(result.score).toBe(0);
  });

  test('HIRING_TECH + LPR yields +70', () => {
    const result = scoreLead({
      ...VALID_BASE,
      signals: [{ type: 'HIRING_TECH' }, { type: 'LPR' }],
    });
    expect(result.score).toBe(70);
  });

  test('all four signals: HIRING_TECH + LPR + SECURITY + OUTSTAFFING = +50', () => {
    const result = scoreLead({
      ...VALID_BASE,
      signals: [
        { type: 'HIRING_TECH' },
        { type: 'LPR' },
        { type: 'SECURITY' },
        { type: 'OUTSTAFFING' },
      ],
    });
    expect(result.score).toBe(50);
  });
});

// ── AC-012: MVA Mapping — DeFi and Wallet trigger Security Layer ─────────────

describe('mapMVA — AC-012: DeFi and Wallet trigger Security Layer', () => {
  const BASE_SCORED = { companyId: 'company-123', score: 40, mvaRecommendations: [] };

  test('DeFi triggers "Security Layer (HSM/Multisig)"', () => {
    const result = mapMVA({ ...BASE_SCORED, sector: 'DeFi' });
    expect(result.mvaRecommendations).toContain('Security Layer (HSM/Multisig)');
  });

  test('Wallet triggers "Security Layer (HSM/Multisig)"', () => {
    const result = mapMVA({ ...BASE_SCORED, sector: 'Wallet' });
    expect(result.mvaRecommendations).toContain('Security Layer (HSM/Multisig)');
  });

  test('case-insensitive: "wallet" triggers Security Layer', () => {
    const result = mapMVA({ ...BASE_SCORED, sector: 'wallet' });
    expect(result.mvaRecommendations).toContain('Security Layer (HSM/Multisig)');
  });
});

// ── AC-013: MVA Mapping — other sectors do not trigger Security Layer ─────────

describe('mapMVA — AC-013: Other sectors do not trigger Security Layer', () => {
  const BASE_SCORED = { companyId: 'company-123', score: 40, mvaRecommendations: [] };

  test('Fintech does not trigger Security Layer', () => {
    const result = mapMVA({ ...BASE_SCORED, sector: 'Fintech' });
    expect(result.mvaRecommendations).not.toContain('Security Layer (HSM/Multisig)');
  });

  test('Web3, Crypto, Stablecoin do not trigger Security Layer', () => {
    for (const sector of ['Web3', 'Crypto', 'Stablecoin']) {
      const result = mapMVA({ ...BASE_SCORED, sector });
      expect(result.mvaRecommendations).not.toContain('Security Layer (HSM/Multisig)');
    }
  });
});
