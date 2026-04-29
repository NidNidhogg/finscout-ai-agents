import {
  createXSignalSource,
  matchesTemplates,
  detectAntiVocab,
  matchPrimarySignals,
  XRateLimitError,
  XAuthError,
  XNetworkError,
  XSignalSourceError,
} from './XSignalSource';
import type {
  Tweet,
  XApiClient,
  CompanyResolver,
  ResolvedCompany,
  XSignalSourceConfig,
} from './XSignalSource';
import type { ResolvedFingerprint } from '../../fingerprint/schemas';

// ── Factories ─────────────────────────────────────────────────────────────────

function makeTweet(overrides: Partial<Tweet> = {}): Tweet {
  return {
    id: 'tweet-1',
    text: 'we raised $5M seed round for our DeFi protocol, multisig wallet infrastructure',
    authorHandle: '@acmedefi',
    authorBio: 'building defi infrastructure | founder @acmedefi',
    postedAt: '2026-04-25T00:00:00.000Z',
    ...overrides,
  };
}

function makeFingerprint(overrides: Partial<ResolvedFingerprint> = {}): ResolvedFingerprint {
  return {
    cell: 'DeFi & Yield',
    resolvedAt: '2026-04-25T00:00:00.000Z',
    primarySignals: [
      { term: 'multisig', weight: 1.5 },
      { term: 'defi', weight: 1.0 },
    ],
    antiSignals: [{ term: 'airdrop', weight: 1.0 }],
    ...overrides,
  };
}

function makeResolver(result?: ResolvedCompany | null | 'throw'): CompanyResolver {
  return {
    resolve: jest.fn().mockImplementation(() => {
      if (result === 'throw') throw new Error('resolver failed');
      return Promise.resolve(result !== undefined ? result : { websiteUrl: 'https://acmedefi.io' });
    }),
  };
}

function makeXApiClient(tweets?: Tweet[] | 'throw:XRateLimitError' | 'throw:XAuthError' | 'throw:XNetworkError'): XApiClient {
  return {
    searchRecentTweets: jest.fn().mockImplementation(() => {
      if (tweets === 'throw:XRateLimitError') return Promise.reject(new XRateLimitError(30000));
      if (tweets === 'throw:XAuthError') return Promise.reject(new XAuthError());
      if (tweets === 'throw:XNetworkError') return Promise.reject(new XNetworkError(new Error('network')));
      return Promise.resolve(tweets ?? [makeTweet()]);
    }),
  };
}

function makeSource(overrides: {
  xClient?: XApiClient;
  resolver?: CompanyResolver;
  fingerprints?: ResolvedFingerprint[];
  config?: XSignalSourceConfig;
} = {}) {
  return createXSignalSource({
    xClient: overrides.xClient ?? makeXApiClient(),
    resolver: overrides.resolver ?? makeResolver(),
    fingerprints: overrides.fingerprints ?? [makeFingerprint()],
    config: overrides.config ?? { searchQuery: 'seed round defi', densityThreshold: 1 },
  });
}

// ── AC-001 ────────────────────────────────────────────────────────────────────

describe('AC-001: no template match returns empty array', () => {
  it('returns [] when no tweet matches a funding template', async () => {
    const xClient = makeXApiClient([
      makeTweet({ text: 'just building defi infrastructure, multisig wallet' }),
    ]);
    const result = await makeSource({ xClient }).pollOnce();
    expect(result).toHaveLength(0);
  });
});

// ── AC-002 ────────────────────────────────────────────────────────────────────

describe('AC-002: anti-vocab unconditionally disqualifies even with primary signals present', () => {
  it('rejects tweet with template + anti-vocab + primary signals', async () => {
    const xClient = makeXApiClient([
      makeTweet({ text: 'we raised $5M seed round multisig defi airdrop giveaway' }),
    ]);
    const fingerprint = makeFingerprint({
      antiSignals: [{ term: 'airdrop', weight: 1.0 }],
      primarySignals: [{ term: 'multisig', weight: 1.5 }, { term: 'defi', weight: 1.0 }],
    });
    const result = await makeSource({ xClient, fingerprints: [fingerprint] }).pollOnce();
    expect(result).toHaveLength(0);
  });
});

// ── AC-003 ────────────────────────────────────────────────────────────────────

describe('AC-003: insufficient density rejects tweet; resolver never called', () => {
  it('rejects tweet with template but no primary signals; resolver not invoked', async () => {
    const xClient = makeXApiClient([
      makeTweet({ text: 'we raised $5M seed round', authorBio: 'founder' }),
    ]);
    const fingerprint = makeFingerprint({ primarySignals: [{ term: 'multisig', weight: 1.5 }] });
    const resolver = makeResolver();
    const result = await makeSource({
      xClient,
      fingerprints: [fingerprint],
      resolver,
      config: { searchQuery: 'seed round', densityThreshold: 1 },
    }).pollOnce();
    expect(result).toHaveLength(0);
    expect(resolver.resolve).not.toHaveBeenCalled();
  });
});

// ── AC-004 ────────────────────────────────────────────────────────────────────

describe('AC-004: resolver returning null excludes tweet without throwing', () => {
  it('returns [] when resolver returns null; pollOnce does not throw', async () => {
    const resolver = makeResolver(null);
    const result = await makeSource({ resolver }).pollOnce();
    expect(result).toHaveLength(0);
  });
});

// ── AC-005 ────────────────────────────────────────────────────────────────────

describe('AC-005: tweet passing all four filters produces one CompanyCandidate', () => {
  it('returns exactly one candidate for the default happy-path tweet', async () => {
    const result = await makeSource().pollOnce();
    expect(result).toHaveLength(1);
    expect(result[0].tweetId).toBe('tweet-1');
    expect(result[0].resolvedCompany.websiteUrl).toBe('https://acmedefi.io');
  });
});

// ── AC-006 ────────────────────────────────────────────────────────────────────

describe('AC-006: anti-vocab term present only in bio causes filter-2 rejection', () => {
  it('rejects tweet when anti-vocab term is in bio only', async () => {
    const xClient = makeXApiClient([
      makeTweet({ text: 'we raised $5M seed round multisig defi', authorBio: 'wen airdrop? building DeFi' }),
    ]);
    const fingerprint = makeFingerprint({ antiSignals: [{ term: 'airdrop', weight: 1.0 }] });
    const result = await makeSource({ xClient, fingerprints: [fingerprint] }).pollOnce();
    expect(result).toHaveLength(0);
  });
});

// ── AC-007 ────────────────────────────────────────────────────────────────────

describe('AC-007: primary signal in bio counts toward density threshold', () => {
  it('returns candidate when primary signal term is in bio only', async () => {
    const xClient = makeXApiClient([
      makeTweet({ text: 'we raised $5M seed round', authorBio: 'multisig infrastructure builder' }),
    ]);
    const fingerprint = makeFingerprint({
      primarySignals: [{ term: 'multisig', weight: 1.5 }],
      antiSignals: [],
    });
    const result = await makeSource({
      xClient,
      fingerprints: [fingerprint],
      resolver: makeResolver(),
      config: { searchQuery: 'seed round', densityThreshold: 1 },
    }).pollOnce();
    expect(result).toHaveLength(1);
    expect(result[0].matchedPrimarySignals).toContain('multisig');
  });
});

// ── AC-008 ────────────────────────────────────────────────────────────────────

describe('AC-008: anti-vocab from all injected fingerprints combined', () => {
  it('rejects tweet when anti-vocab term comes from a second fingerprint', async () => {
    const fp1 = makeFingerprint({
      cell: 'DeFi & Yield',
      antiSignals: [{ term: 'airdrop', weight: 1.0 }],
      primarySignals: [{ term: 'multisig', weight: 1.5 }],
    });
    const fp2 = makeFingerprint({
      cell: 'Trading',
      antiSignals: [{ term: '100x', weight: 1.0 }],
      primarySignals: [{ term: 'AMM', weight: 1.0 }],
    });
    const xClient = makeXApiClient([
      makeTweet({ text: 'we raised $5M seed round multisig AMM 100x gains', authorBio: undefined }),
    ]);
    const result = await makeSource({
      fingerprints: [fp1, fp2],
      xClient,
      resolver: makeResolver(),
    }).pollOnce();
    expect(result).toHaveLength(0);
  });
});

// ── AC-009 ────────────────────────────────────────────────────────────────────

describe('AC-009: matchedTemplates contains all fired template phrases', () => {
  it('includes at least seed round from a multi-template tweet', async () => {
    const xClient = makeXApiClient([
      makeTweet({ text: 'we raised $5M seed round, thrilled to announce our infrastructure build' }),
    ]);
    const result = await makeSource({ xClient }).pollOnce();
    expect(result[0].matchedTemplates.length).toBeGreaterThanOrEqual(1);
    expect(result[0].matchedTemplates).toContain('seed round');
  });
});

// ── AC-010 ────────────────────────────────────────────────────────────────────

describe('AC-010: matchedPrimarySignals contains all matching terms', () => {
  it('includes multisig, defi, and TVL when all appear in text or bio', async () => {
    const xClient = makeXApiClient([
      makeTweet({ text: 'we raised $5M seed round defi multisig', authorBio: 'building TVL infrastructure' }),
    ]);
    const fingerprint = makeFingerprint({
      primarySignals: [
        { term: 'multisig', weight: 1.5 },
        { term: 'defi', weight: 1.0 },
        { term: 'TVL', weight: 1.2 },
      ],
      antiSignals: [],
    });
    const result = await makeSource({ xClient, fingerprints: [fingerprint] }).pollOnce();
    expect(result[0].matchedPrimarySignals).toContain('multisig');
    expect(result[0].matchedPrimarySignals).toContain('defi');
    expect(result[0].matchedPrimarySignals).toContain('TVL');
  });
});

// ── AC-011 ────────────────────────────────────────────────────────────────────

describe('AC-011: matchedCells may be empty even when candidate passes filter 3', () => {
  it('returns candidate with matchedCells: [] when union passes but per-cell density fails', async () => {
    const fp1 = makeFingerprint({
      cell: 'DeFi & Yield',
      primarySignals: [{ term: 'TVL', weight: 1.2 }, { term: 'flash loan', weight: 2.0 }],
      antiSignals: [],
    });
    const fp2 = makeFingerprint({
      cell: 'Trading',
      primarySignals: [{ term: 'AMM', weight: 1.0 }, { term: 'DEX', weight: 1.0 }],
      antiSignals: [],
    });
    const xClient = makeXApiClient([
      makeTweet({ text: 'we raised $5M seed round TVL AMM', authorBio: undefined }),
    ]);
    const result = await makeSource({
      fingerprints: [fp1, fp2],
      xClient,
      resolver: makeResolver(),
      config: { searchQuery: '...', densityThreshold: 2 },
    }).pollOnce();
    expect(result).toHaveLength(1);
    expect(result[0].matchedCells).toHaveLength(0);
    expect(result[0].matchedPrimarySignals).toHaveLength(2);
  });
});

// ── AC-012 ────────────────────────────────────────────────────────────────────

describe('AC-012: resolvedCompany.websiteUrl equals resolver output', () => {
  it('maps resolver websiteUrl and name faithfully', async () => {
    const resolver = makeResolver({ websiteUrl: 'https://protocol.xyz', name: 'Protocol XYZ' });
    const result = await makeSource({ resolver }).pollOnce();
    expect(result[0].resolvedCompany.websiteUrl).toBe('https://protocol.xyz');
    expect(result[0].resolvedCompany.name).toBe('Protocol XYZ');
  });
});

// ── AC-013 ────────────────────────────────────────────────────────────────────

describe('AC-013: discoveredAt is a valid ISO 8601 string at or after pre-call time', () => {
  it('discoveredAt is set at candidate construction time', async () => {
    const preCallTime = new Date();
    const result = await makeSource().pollOnce();
    expect(result[0].discoveredAt).toBeTruthy();
    expect(new Date(result[0].discoveredAt).getTime()).not.toBeNaN();
    expect(new Date(result[0].discoveredAt) >= preCallTime).toBe(true);
  });
});

// ── AC-014 to AC-016 ──────────────────────────────────────────────────────────

describe('AC-014: XRateLimitError propagates without retry', () => {
  it('rejects with XRateLimitError', async () => {
    const xClient = makeXApiClient('throw:XRateLimitError');
    await expect(makeSource({ xClient }).pollOnce()).rejects.toBeInstanceOf(XRateLimitError);
    await expect(makeSource({ xClient: makeXApiClient('throw:XRateLimitError') }).pollOnce())
      .rejects.toBeInstanceOf(XSignalSourceError);
  });
});

describe('AC-015: XAuthError propagates without retry', () => {
  it('rejects with XAuthError', async () => {
    const xClient = makeXApiClient('throw:XAuthError');
    await expect(makeSource({ xClient }).pollOnce()).rejects.toBeInstanceOf(XAuthError);
  });
});

describe('AC-016: XNetworkError propagates without retry', () => {
  it('rejects with XNetworkError', async () => {
    const xClient = makeXApiClient('throw:XNetworkError');
    await expect(makeSource({ xClient }).pollOnce()).rejects.toBeInstanceOf(XNetworkError);
  });
});

// ── AC-017 ────────────────────────────────────────────────────────────────────

describe('AC-017: resolver null drops tweet silently', () => {
  it('resolves to [] when resolver returns null', async () => {
    const result = await makeSource({ resolver: makeResolver(null) }).pollOnce();
    expect(result).toHaveLength(0);
  });
});

// ── AC-018 ────────────────────────────────────────────────────────────────────

describe('AC-018: resolver error propagates from pollOnce()', () => {
  it('rejects when resolver throws', async () => {
    await expect(makeSource({ resolver: makeResolver('throw') }).pollOnce()).rejects.toThrow();
  });
});

// ── AC-019 ────────────────────────────────────────────────────────────────────

describe('AC-019: duplicate tweet.id yields at most one CompanyCandidate', () => {
  it('returns one candidate when same id appears twice', async () => {
    const xClient = makeXApiClient([makeTweet({ id: 'dup-1' }), makeTweet({ id: 'dup-1' })]);
    const result = await makeSource({ xClient }).pollOnce();
    expect(result).toHaveLength(1);
    expect(result[0].tweetId).toBe('dup-1');
  });
});

// ── AC-020 ────────────────────────────────────────────────────────────────────

describe('AC-020: two distinct tweets resolving to same URL each produce a candidate', () => {
  it('returns two candidates', async () => {
    const xClient = makeXApiClient([
      makeTweet({ id: 'tweet-1', authorHandle: '@alice' }),
      makeTweet({ id: 'tweet-2', authorHandle: '@bob' }),
    ]);
    const resolver = makeResolver({ websiteUrl: 'https://same-company.io' });
    const result = await makeSource({ xClient, resolver }).pollOnce();
    expect(result).toHaveLength(2);
    expect(result[0].tweetId).toBe('tweet-1');
    expect(result[1].tweetId).toBe('tweet-2');
    expect(result[0].resolvedCompany.websiteUrl).toBe('https://same-company.io');
    expect(result[1].resolvedCompany.websiteUrl).toBe('https://same-company.io');
  });
});

// ── AC-021 ────────────────────────────────────────────────────────────────────

describe('AC-021: stub XApiClient enables filter-pipeline testing', () => {
  it('searches via the stub and returns one candidate', async () => {
    const xClient = makeXApiClient([makeTweet()]);
    const result = await makeSource({ xClient }).pollOnce();
    expect(result).toHaveLength(1);
    expect(xClient.searchRecentTweets).toHaveBeenCalledTimes(1);
  });
});

// ── AC-022 ────────────────────────────────────────────────────────────────────

describe('AC-022: replacing fingerprints changes which tweets pass', () => {
  it('run A passes with matching vocab; run B fails with wrong vocab', async () => {
    const tweet = makeTweet({ text: 'we raised $5M seed round TVL flash loan', authorBio: undefined });

    const fpA = makeFingerprint({ primarySignals: [{ term: 'TVL', weight: 1.2 }], antiSignals: [] });
    const resultA = await makeSource({
      xClient: makeXApiClient([tweet]),
      fingerprints: [fpA],
      config: { searchQuery: 'seed round', densityThreshold: 1 },
    }).pollOnce();
    expect(resultA).toHaveLength(1);

    const fpB = makeFingerprint({ primarySignals: [{ term: 'AMM', weight: 1.0 }], antiSignals: [] });
    const resultB = await makeSource({
      xClient: makeXApiClient([tweet]),
      fingerprints: [fpB],
      config: { searchQuery: 'seed round', densityThreshold: 1 },
    }).pollOnce();
    expect(resultB).toHaveLength(0);
  });
});

// ── AC-023 ────────────────────────────────────────────────────────────────────

describe('AC-023: densityThreshold defaults to 1', () => {
  it('passes with exactly one primary signal when threshold unspecified', async () => {
    const xClient = makeXApiClient([
      makeTweet({ text: 'we raised $5M seed round multisig', authorBio: undefined }),
    ]);
    const fp = makeFingerprint({ primarySignals: [{ term: 'multisig', weight: 1.5 }], antiSignals: [] });
    const result = await makeSource({
      xClient,
      fingerprints: [fp],
      config: { searchQuery: 'seed round' },
    }).pollOnce();
    expect(result).toHaveLength(1);
  });
});

// ── AC-024 ────────────────────────────────────────────────────────────────────

describe('AC-024: densityThreshold: 2 requires at least two distinct primary signal matches', () => {
  it('tweet A (1 match) rejected; tweet B (2 matches) passes', async () => {
    const fp = makeFingerprint({
      primarySignals: [{ term: 'multisig', weight: 1.5 }, { term: 'defi', weight: 1.0 }],
      antiSignals: [],
    });
    const config: XSignalSourceConfig = { searchQuery: '...', densityThreshold: 2 };

    const resultA = await makeSource({
      xClient: makeXApiClient([makeTweet({ id: 'a', text: 'we raised $5M seed round multisig', authorBio: undefined })]),
      fingerprints: [fp],
      config,
    }).pollOnce();
    expect(resultA).toHaveLength(0);

    const resultB = await makeSource({
      xClient: makeXApiClient([makeTweet({ id: 'b', text: 'we raised $5M seed round multisig defi', authorBio: undefined })]),
      fingerprints: [fp],
      config,
    }).pollOnce();
    expect(resultB).toHaveLength(1);
  });
});

// ── AC-025 ────────────────────────────────────────────────────────────────────

describe('AC-025: matchesTemplates pure function', () => {
  it('returns [] for empty string', () => {
    expect(matchesTemplates('')).toHaveLength(0);
  });
  it('returns non-empty array for a funding announcement', () => {
    const result = matchesTemplates('we raised $5M seed round');
    expect(result.length).toBeGreaterThanOrEqual(1);
    const knownPhrases = ['seed round', 'raised $', 'we raised'];
    expect(result.some((p) => knownPhrases.includes(p))).toBe(true);
  });
});

// ── AC-026 ────────────────────────────────────────────────────────────────────

describe('AC-026: detectAntiVocab returns matched term from bio', () => {
  it('returns "airdrop" when present only in bio', () => {
    const result = detectAntiVocab(
      'we raised $5M seed round multisig defi',
      'wen airdrop?',
      [{ term: 'airdrop', weight: 1.0 }],
    );
    expect(result).toBe('airdrop');
  });
});

// ── AC-027 ────────────────────────────────────────────────────────────────────

describe('AC-027: matchPrimarySignals returns only present terms', () => {
  it('returns defi and infrastructure; not AMM', () => {
    const result = matchPrimarySignals(
      'we raised $5M seed round DeFi',
      'building infrastructure',
      [
        { term: 'defi', weight: 1.0 },
        { term: 'AMM', weight: 1.5 },
        { term: 'infrastructure', weight: 1.0 },
      ],
    );
    expect(result).toContain('defi');
    expect(result).toContain('infrastructure');
    expect(result).not.toContain('AMM');
    expect(result).toHaveLength(2);
  });
});

// ── AC-028 ────────────────────────────────────────────────────────────────────

describe('AC-028: pollOnce returns [] when API returns empty; resolver not called', () => {
  it('resolver never invoked on empty tweet list', async () => {
    const resolver = makeResolver();
    const result = await makeSource({ xClient: makeXApiClient([]), resolver }).pollOnce();
    expect(result).toHaveLength(0);
    expect(resolver.resolve).not.toHaveBeenCalled();
  });
});
