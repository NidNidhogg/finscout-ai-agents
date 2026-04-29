import { matchesTemplates, detectAntiVocab, matchPrimarySignals } from './filters';
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
