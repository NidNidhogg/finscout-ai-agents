import {
  extractKeywords,
  scoreTweet,
  buildLookAlikeQuery,
  TweetPayload,
  FounderProfile,
} from './XDiscoverySource';
import { ValidationError } from '../sales-factory/errors';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTweet(text: string, id = '1'): TweetPayload {
  return { id, text, authorId: 'user-1', createdAt: '2026-04-16T00:00:00.000Z' };
}

function makeProfile(bio: string, keywords: string[] = []): FounderProfile {
  return { handle: '@test-founder', bio, keywords };
}

// ── extractKeywords ───────────────────────────────────────────────────────────

describe('extractKeywords — keyword extraction from tweet text', () => {
  test('detects "we raised" and "seed round" funding signal phrases', () => {
    const result = extractKeywords(makeTweet('We raised a seed round for our startup!'));
    expect(result.fundingSignals).toContain('we raised');
    expect(result.fundingSignals).toContain('seed round');
  });

  test('detects "thrilled to announce" and sector keyword "defi"', () => {
    const result = extractKeywords(makeTweet('Thrilled to announce our DeFi protocol launch'));
    expect(result.fundingSignals).toContain('thrilled to announce');
    expect(result.sectorKeywords).toContain('defi');
  });

  test('returns empty arrays for tweet with no relevant content', () => {
    const result = extractKeywords(makeTweet('Great day for a walk in the park'));
    expect(result.fundingSignals).toHaveLength(0);
    expect(result.sectorKeywords).toHaveLength(0);
    expect(result.all).toHaveLength(0);
  });

  test('all field contains every item from both fundingSignals and sectorKeywords', () => {
    const result = extractKeywords(makeTweet('We raised seed funding for our fintech startup'));
    for (const kw of [...result.fundingSignals, ...result.sectorKeywords]) {
      expect(result.all).toContain(kw);
    }
    expect(result.all.length).toBe(result.fundingSignals.length + result.sectorKeywords.length);
  });

  test('matching is case-insensitive', () => {
    const result = extractKeywords(makeTweet('THRILLED TO ANNOUNCE our FINTECH platform'));
    expect(result.fundingSignals).toContain('thrilled to announce');
    expect(result.sectorKeywords).toContain('fintech');
  });

  test('throws ValidationError for invalid tweet payload (bad createdAt)', () => {
    const fn = () => extractKeywords({ id: '1', text: 'hello', authorId: 'u1', createdAt: 'not-a-date' });
    expect(fn).toThrow(ValidationError);
    expect(fn).toThrow('createdAt');
  });
});

// ── scoreTweet ────────────────────────────────────────────────────────────────

describe('scoreTweet — priority scoring', () => {
  test('funding signals + sector keywords yields high priority score (≥ 70)', () => {
    // "thrilled to announce" (signal) + "fintech" (sector) + "seed round" (signal)
    const result = scoreTweet(makeTweet('Thrilled to announce our fintech seed round!'));
    expect(result.priorityScore).toBeGreaterThanOrEqual(70);
  });

  test('funding signals only yields score of 50', () => {
    // "just closed" matches; no sector keyword present
    const result = scoreTweet(makeTweet('We just closed our round — very exciting news!'));
    expect(result.priorityScore).toBe(50);
  });

  test('sector keywords only yields score of 30', () => {
    // no funding signal phrases; DeFi + crypto are sector hits
    const result = scoreTweet(makeTweet('Building the future of DeFi and crypto'));
    expect(result.priorityScore).toBe(30);
  });

  test('no relevant content yields score of 0', () => {
    const result = scoreTweet(makeTweet('Lovely weather today, coffee is great'));
    expect(result.priorityScore).toBe(0);
  });

  test('scored result carries tweetId and extracted signal metadata', () => {
    const result = scoreTweet(makeTweet('We raised seed funding for our fintech', '42'));
    expect(result.tweetId).toBe('42');
    expect(result.fundingSignals.length).toBeGreaterThan(0);
    expect(result.sectorKeywords).toContain('fintech');
  });

  test('throws ValidationError for invalid tweet payload (bad createdAt)', () => {
    const fn = () => scoreTweet({ id: '1', text: 'hello', authorId: 'u1', createdAt: 'not-a-date' });
    expect(fn).toThrow(ValidationError);
    expect(fn).toThrow('createdAt');
  });
});

// ── buildLookAlikeQuery ───────────────────────────────────────────────────────

describe('buildLookAlikeQuery — look-alike founder query builder', () => {
  test('extracts sector keywords from founder bio', () => {
    const result = buildLookAlikeQuery(
      makeProfile('DeFi protocol founder | building crypto infrastructure'),
    );
    expect(result.keywords).toContain('defi');
    expect(result.keywords).toContain('crypto');
  });

  test('includes explicit profile keywords in result', () => {
    const result = buildLookAlikeQuery(
      makeProfile('serial entrepreneur', ['fintech', 'seed']),
    );
    expect(result.keywords).toContain('fintech');
  });

  test('queryString is non-empty and contains keywords for a relevant profile', () => {
    const result = buildLookAlikeQuery(
      makeProfile('Web3 founder | stablecoin builder', ['web3']),
    );
    expect(result.queryString).not.toBe('');
    expect(result.queryString).toContain('web3');
    expect(result.queryString).toContain('stablecoin');
    expect(result.queryString).toContain('OR');
  });

  test('deduplicates keywords appearing in both bio and explicit list', () => {
    const result = buildLookAlikeQuery(
      makeProfile('fintech startup founder', ['fintech']),
    );
    const count = result.keywords.filter((k) => k === 'fintech').length;
    expect(count).toBe(1);
  });

  test('returns empty keywords and empty queryString for irrelevant profile', () => {
    const result = buildLookAlikeQuery(makeProfile('coffee lover | travel enthusiast'));
    expect(result.keywords).toHaveLength(0);
    expect(result.queryString).toBe('');
  });

  test('throws ValidationError for profile with empty handle', () => {
    const fn = () => buildLookAlikeQuery({ handle: '', bio: 'something', keywords: [] });
    expect(fn).toThrow(ValidationError);
    expect(fn).toThrow('handle');
  });
});
