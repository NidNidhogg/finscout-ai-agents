import { matchesTemplates, detectAntiVocab, matchPrimarySignals, extractFundingAmountUSD, isBelowFundingThreshold } from './filters';
import type { Signal } from '../../fingerprint/schemas';

// ── matchesTemplates ──────────────────────────────────────────────────────────

describe('matchesTemplates', () => {
  test('AC-025: returns empty array for empty string', () => {
    expect(matchesTemplates('')).toEqual([]);
  });

  test('AC-025: returns non-empty array containing the matched phrase for a known funding announcement', () => {
    const result = matchesTemplates('we raised $5M seed round');
    expect(result.length).toBeGreaterThan(0);
    expect(result.some((p) => p.length > 0)).toBe(true);
  });

  test('returns every template phrase that appears in the text', () => {
    const result = matchesTemplates('we raised $5M seed round, thrilled to announce our new funding round');
    expect(result).toContain('seed round');
    expect(result).toContain('we raised');
    expect(result).toContain('raised $');
    expect(result).toContain('thrilled to announce');
    expect(result).toContain('new funding');
  });

  test('is case-insensitive', () => {
    expect(matchesTemplates('WE RAISED $5M')).toContain('we raised');
    expect(matchesTemplates('SEED ROUND announced')).toContain('seed round');
  });

  test('returns empty array when no template phrase is present', () => {
    expect(matchesTemplates('just building defi infrastructure, multisig wallet')).toEqual([]);
  });

  // New phrase coverage — caught by real X query results
  test('matches "in funding" pattern ($15M in funding)', () => {
    expect(matchesTemplates('Startup raises $15M in funding to expand DeFi')).toContain('in funding');
  });

  test('matches "m raised" pattern ($8M raised)', () => {
    expect(matchesTemplates('DeFi protocol raises $8M raised in seed round')).toContain('m raised');
  });

  test('matches "k raised" pattern ($500k raised)', () => {
    expect(matchesTemplates('Web3 startup closes $500k raised from angels')).toContain('k raised');
  });

  test('matches "pre-seed" pattern', () => {
    expect(matchesTemplates('Excited to announce our pre-seed funding round')).toContain('pre-seed');
  });

  test('matches "series a" pattern', () => {
    expect(matchesTemplates('We just closed our Series A round')).toContain('series a');
  });

  test('matches "funding round" pattern', () => {
    expect(matchesTemplates('Announcing our latest funding round for blockchain infra')).toContain('funding round');
  });

  test('matches "investment round" pattern', () => {
    expect(matchesTemplates('We completed our investment round led by a16z')).toContain('investment round');
  });

  test('matches "strategic round" pattern', () => {
    expect(matchesTemplates('Closing our strategic round to accelerate DeFi growth')).toContain('strategic round');
  });
});

// ── extractFundingAmountUSD ───────────────────────────────────────────────────

describe('extractFundingAmountUSD', () => {
  test('$500k → 500_000', () => {
    expect(extractFundingAmountUSD('We raised $500k in pre-seed')).toBe(500_000);
  });

  test('$100K uppercase → 100_000', () => {
    expect(extractFundingAmountUSD('Startup raises $100K')).toBe(100_000);
  });

  test('$750K → 750_000', () => {
    expect(extractFundingAmountUSD('closed $750K round')).toBe(750_000);
  });

  test('$1M → 1_000_000', () => {
    expect(extractFundingAmountUSD('raised $1M seed')).toBe(1_000_000);
  });

  test('$1.5M → 1_500_000', () => {
    expect(extractFundingAmountUSD('we raised $1.5M seed round')).toBe(1_500_000);
  });

  test('$10M → 10_000_000', () => {
    expect(extractFundingAmountUSD('Excited to share we raised $10M')).toBe(10_000_000);
  });

  test('$10m lowercase → 10_000_000', () => {
    expect(extractFundingAmountUSD('closed a $10m round')).toBe(10_000_000);
  });

  test('$222M → 222_000_000', () => {
    expect(extractFundingAmountUSD('Circle just raised $222M for its Arc token')).toBe(222_000_000);
  });

  test('$1.5 million (word form) → 1_500_000', () => {
    expect(extractFundingAmountUSD('raised 1.5 million for our protocol')).toBe(1_500_000);
  });

  test('$8 million (dollar + word) → 8_000_000', () => {
    expect(extractFundingAmountUSD('$8 million raised for web3 infra')).toBe(8_000_000);
  });

  test('500 thousand → 500_000', () => {
    expect(extractFundingAmountUSD('raised 500 thousand in angel round')).toBe(500_000);
  });

  test('no amount → null', () => {
    expect(extractFundingAmountUSD('seed round for DeFi protocol')).toBeNull();
    expect(extractFundingAmountUSD('pre-seed funding round announced')).toBeNull();
    expect(extractFundingAmountUSD('thrilled to announce our funding round')).toBeNull();
  });
});

// ── isBelowFundingThreshold ───────────────────────────────────────────────────

describe('isBelowFundingThreshold', () => {
  const THRESHOLD = 1_000_000;

  test('$500k → blocked (below $1M)', () => {
    expect(isBelowFundingThreshold('raised $500k in pre-seed', THRESHOLD)).toBe(true);
  });

  test('$100k → blocked', () => {
    expect(isBelowFundingThreshold('Startup raises $100K', THRESHOLD)).toBe(true);
  });

  test('$999k → blocked (just under threshold)', () => {
    expect(isBelowFundingThreshold('raised $999k', THRESHOLD)).toBe(true);
  });

  test('$1M → passes (exactly at threshold)', () => {
    expect(isBelowFundingThreshold('raised $1M seed', THRESHOLD)).toBe(false);
  });

  test('$1.5M → passes', () => {
    expect(isBelowFundingThreshold('raised $1.5M round', THRESHOLD)).toBe(false);
  });

  test('$10M → passes', () => {
    expect(isBelowFundingThreshold('closed $10M series a', THRESHOLD)).toBe(false);
  });

  test('no amount → passes (undisclosed rounds are valuable)', () => {
    expect(isBelowFundingThreshold('seed round for DeFi protocol', THRESHOLD)).toBe(false);
    expect(isBelowFundingThreshold('thrilled to announce our pre-seed', THRESHOLD)).toBe(false);
    expect(isBelowFundingThreshold('funding round announced', THRESHOLD)).toBe(false);
  });
});

// ── detectAntiVocab ───────────────────────────────────────────────────────────

describe('detectAntiVocab', () => {
  const antiSignals: Signal[] = [
    { term: 'airdrop', weight: 1.0 },
    { term: 'giveaway', weight: 1.0 },
  ];

  test('AC-026: returns matched term when the anti-signal appears in bio but not text', () => {
    const result = detectAntiVocab(
      'we raised $5M seed round for our DeFi protocol',
      'wen airdrop? building DeFi infrastructure',
      antiSignals,
    );
    expect(result).toBe('airdrop');
  });

  test('returns matched term when it appears in text', () => {
    const result = detectAntiVocab(
      'we raised $5M seed round — airdrop campaign coming soon',
      undefined,
      antiSignals,
    );
    expect(result).toBe('airdrop');
  });

  test('returns null when no anti-signal term is present in text or bio', () => {
    const result = detectAntiVocab(
      'we raised $5M seed round',
      'building DeFi infrastructure',
      antiSignals,
    );
    expect(result).toBeNull();
  });

  test('returns null when bio is undefined and text has no match', () => {
    const result = detectAntiVocab('clean tweet about funding', undefined, antiSignals);
    expect(result).toBeNull();
  });

  test('is case-insensitive in text', () => {
    expect(detectAntiVocab('AIRDROP tomorrow', undefined, antiSignals)).toBe('airdrop');
  });

  test('is case-insensitive in bio', () => {
    expect(detectAntiVocab('clean tweet', 'GIVEAWAY every week', antiSignals)).toBe('giveaway');
  });

  test('returns empty-array signal list as null', () => {
    expect(detectAntiVocab('airdrop', 'airdrop', [])).toBeNull();
  });
});

// ── matchPrimarySignals ───────────────────────────────────────────────────────

describe('matchPrimarySignals', () => {
  const primarySignals: Signal[] = [
    { term: 'multisig', weight: 1.5 },
    { term: 'defi', weight: 1.0 },
    { term: 'TVL', weight: 1.2 },
  ];

  test('AC-027: returns only terms found in text or bio; absent terms excluded', () => {
    const result = matchPrimarySignals(
      'building multisig infrastructure',
      'working on defi protocols',
      primarySignals,
    );
    expect(result).toContain('multisig');
    expect(result).toContain('defi');
    expect(result).not.toContain('TVL');
  });

  test('AC-027: returns empty array when no primary signal matches text or bio', () => {
    const result = matchPrimarySignals('random unrelated content', 'unrelated bio', primarySignals);
    expect(result).toEqual([]);
  });

  test('returns terms found in bio when text has no match', () => {
    const result = matchPrimarySignals('we raised $5M seed round', 'building defi protocol', primarySignals);
    expect(result).toContain('defi');
    expect(result).not.toContain('multisig');
    expect(result).not.toContain('TVL');
  });

  test('does not short-circuit — all terms are checked', () => {
    const result = matchPrimarySignals(
      'multisig defi TVL protocol infrastructure',
      undefined,
      primarySignals,
    );
    expect(result).toContain('multisig');
    expect(result).toContain('defi');
    expect(result).toContain('TVL');
    expect(result).toHaveLength(3);
  });

  test('is case-insensitive', () => {
    expect(matchPrimarySignals('MULTISIG wallet', 'TVL tracking', primarySignals)).toContain('multisig');
    expect(matchPrimarySignals('MULTISIG wallet', 'TVL tracking', primarySignals)).toContain('TVL');
  });

  test('returns empty array when primarySignals list is empty', () => {
    expect(matchPrimarySignals('multisig defi', 'TVL', [])).toEqual([]);
  });

  test('returns empty array when bio is undefined and text has no match', () => {
    const result = matchPrimarySignals('no signals here', undefined, primarySignals);
    expect(result).toEqual([]);
  });
});
