# TEST SCAFFOLD: X Signal Source
<!-- Companion to: specs/x-signal-source/spec.md v1.0 -->
<!-- This document is stack-agnostic. It describes WHAT to test, not HOW. -->

---

<!--
Helper reference (stack-agnostic descriptions):

  makeTweet(overrides?) — returns a Tweet that passes all four filters by default:
    id: 'tweet-1',
    text: 'we raised $5M seed round for our DeFi protocol, multisig wallet infrastructure',
    authorHandle: '@acmedefi',
    authorBio: 'building defi infrastructure | founder @acmedefi',
    postedAt: '2026-04-25T00:00:00.000Z'.
    Top-level overrides spread onto base.

  makeFingerprint(overrides?) — returns a ResolvedFingerprint with defaults:
    cell: 'DeFi & Yield',
    resolvedAt: '2026-04-25T00:00:00.000Z',
    primarySignals: [{ term: 'multisig', weight: 1.5 }, { term: 'defi', weight: 1.0 }],
    antiSignals: [{ term: 'airdrop', weight: 1.0 }].
    Top-level overrides spread onto base.

  makeResolver(result?) — returns a stub CompanyResolver whose resolve() returns
    Promise<result ?? { websiteUrl: 'https://acmedefi.io' }>.
    When result is the string 'throw', resolve() throws a generic Error instead.

  makeXApiClient(tweets?) — returns a stub XApiClient whose searchRecentTweets()
    returns Promise<tweets ?? [makeTweet()]>.
    When tweets is the string 'throw:<ErrorClass>', searchRecentTweets() throws
    an instance of that error class (e.g., XRateLimitError, XAuthError, XNetworkError).

  makeSource(overrides?) — builds an XSignalSource via createXSignalSource() with:
    xClient: makeXApiClient(),
    resolver: makeResolver(),
    fingerprints: [makeFingerprint()],
    config: { searchQuery: 'seed round defi', densityThreshold: 1 }.
    Individual dep/config fields may be replaced via overrides.

  All XSignalSource tests are pure integration tests over the filter pipeline using
  stub dependencies. No real HTTP calls, no file I/O, no timing dependencies beyond
  checking that discoveredAt is at or after a pre-call timestamp.
-->

---

## AC-001: pollOnce() returns an empty array when no tweet matches a funding template

### Edge Case — filter 1 rejects all tweets

- **Setup:** `makeXApiClient([makeTweet({ text: 'just building defi infrastructure, multisig wallet' })])` — a tweet with primary signals present but no funding-announcement template phrase (no 'raised $', 'seed round', 'thrilled to announce', etc.)
- **Input:** `makeSource({ xClient: ... }).pollOnce()`
- **Expected Output:** resolves to `[]`
- **Assertions:**
  - `result.length === 0`

---

## AC-002: A tweet matching a template AND containing an anti-vocab term is rejected regardless of primary signal presence

### Edge Case — anti-vocab unconditionally disqualifies; filter ordering invariant

- **Setup:** `makeXApiClient([makeTweet({ text: 'we raised $5M seed round multisig defi airdrop giveaway' })])` — template fires, anti-vocab term 'airdrop' present, and ≥1 primary signal also present. `makeFingerprint()` (antiSignals: ['airdrop'], primarySignals: ['multisig', 'defi']). `makeSource({ fingerprints: [fingerprint], xClient: ... })`
- **Input:** `source.pollOnce()`
- **Expected Output:** resolves to `[]`
- **Assertions:**
  - `result.length === 0`

---

## AC-003: A tweet passing filters 1-2 but with insufficient density is rejected; resolver is not called

### Edge Case — filter 3 rejects; resolver never invoked

- **Setup:** `makeXApiClient([makeTweet({ text: 'we raised $5M seed round', authorBio: 'founder' })])` — template fires, no anti-vocab, but no primary signal terms in text or bio. `makeFingerprint({ primarySignals: [{ term: 'multisig', weight: 1.5 }] })`. `densityThreshold: 1`. Use a resolver spy (or a resolver that throws if called) to confirm it is not invoked.
- **Input:** `makeSource({ ... }).pollOnce()`
- **Expected Output:** resolves to `[]`
- **Assertions:**
  - `result.length === 0`
  - The resolver's `resolve()` method was not called

---

## AC-004: A tweet passing filters 1-3 for which the resolver returns null is excluded from output without throwing

### Edge Case — filter 4 drops tweet; pollOnce() does not throw

- **Setup:** `makeXApiClient([makeTweet()])` (passes filters 1-3 with default fingerprint). `makeResolver(null)` — resolver returns null.
- **Input:** `makeSource({ resolver: ... }).pollOnce()`
- **Expected Output:** resolves to `[]`
- **Assertions:**
  - `result.length === 0`

---

## AC-005: A tweet passing all four filters produces exactly one CompanyCandidate in the output

### Happy Path — all filters pass

- **Setup:** `makeSource()` — default stub: `makeTweet()`, `makeFingerprint()`, `makeResolver()`, `densityThreshold: 1`
- **Input:** `source.pollOnce()`
- **Expected Output:** resolves to an array of length 1
- **Assertions:**
  - `result.length === 1`
  - `result[0].tweetId === 'tweet-1'`
  - `result[0].resolvedCompany.websiteUrl === 'https://acmedefi.io'`

---

## AC-006: detectAntiVocab() rejects on a term present only in the bio

### Edge Case — anti-vocab check covers both text and authorBio

- **Setup:** `makeTweet({ text: 'we raised $5M seed round multisig defi', authorBio: 'wen airdrop? building DeFi' })` — 'airdrop' is in the bio only, not in the tweet text. `makeFingerprint()` (antiSignals: ['airdrop']). `makeSource({ xClient: makeXApiClient([tweet]), fingerprints: [fingerprint] })`
- **Input:** `source.pollOnce()`
- **Expected Output:** resolves to `[]`
- **Assertions:**
  - `result.length === 0`

---

## AC-007: matchPrimarySignals() counts a term present only in the bio toward the density threshold

### Happy Path — density check covers both text and authorBio

- **Setup:** `makeTweet({ text: 'we raised $5M seed round', authorBio: 'multisig infrastructure builder' })` — 'multisig' appears only in the bio. `makeFingerprint({ primarySignals: [{ term: 'multisig', weight: 1.5 }], antiSignals: [] })`. `densityThreshold: 1`. `makeResolver()`.
- **Input:** `makeSource({ xClient: makeXApiClient([tweet]), fingerprints: [fingerprint], resolver, config: { searchQuery: 'seed round', densityThreshold: 1 } }).pollOnce()`
- **Expected Output:** resolves to `[CompanyCandidate]`
- **Assertions:**
  - `result.length === 1`
  - `result[0].matchedPrimarySignals` contains `'multisig'`

---

## AC-008: Anti-vocab from all injected fingerprints is combined for filter 2

### Edge Case — multi-fingerprint anti-vocab union

- **Setup:** Two fingerprints: `makeFingerprint({ cell: 'DeFi & Yield', antiSignals: [{ term: 'airdrop', weight: 1.0 }], primarySignals: [{ term: 'multisig', weight: 1.5 }] })` and `makeFingerprint({ cell: 'Trading', antiSignals: [{ term: '100x', weight: 1.0 }], primarySignals: [{ term: 'AMM', weight: 1.0 }] })`. Tweet: `makeTweet({ text: 'we raised $5M seed round multisig AMM 100x gains', authorBio: undefined })` — '100x' fires from the Trading fingerprint's antiSignals. `makeResolver()`.
- **Input:** `makeSource({ fingerprints: [fp1, fp2], xClient: makeXApiClient([tweet]), resolver }).pollOnce()`
- **Expected Output:** resolves to `[]`
- **Assertions:**
  - `result.length === 0`

---

## AC-009: CompanyCandidate.matchedTemplates contains all template phrases that fired

### Happy Path — multiple templates may fire simultaneously

- **Setup:** `makeTweet({ text: 'we raised $5M seed round, thrilled to announce our infrastructure build' })` — both 'seed round' and 'thrilled to announce' (and potentially 'raised $') are present. `makeSource()`.
- **Input:** `source.pollOnce()`
- **Expected Output:** `result[0].matchedTemplates` is a non-empty array containing every template phrase that is a substring of the tweet text
- **Assertions:**
  - `result[0].matchedTemplates.length >= 1`
  - `result[0].matchedTemplates` contains `'seed round'`

---

## AC-010: CompanyCandidate.matchedPrimarySignals contains all primary signal terms that matched

### Happy Path — all matching terms present in output

- **Setup:** `makeTweet({ text: 'we raised $5M seed round defi multisig', authorBio: 'building TVL infrastructure' })`. `makeFingerprint({ primarySignals: [{ term: 'multisig', weight: 1.5 }, { term: 'defi', weight: 1.0 }, { term: 'TVL', weight: 1.2 }], antiSignals: [] })`. `makeSource()`.
- **Input:** `source.pollOnce()`
- **Expected Output:** `result[0].matchedPrimarySignals` contains `'multisig'`, `'defi'`, and `'TVL'`
- **Assertions:**
  - `result[0].matchedPrimarySignals` includes `'multisig'`
  - `result[0].matchedPrimarySignals` includes `'defi'`
  - `result[0].matchedPrimarySignals` includes `'TVL'`

---

## AC-011: matchedCells may be empty even when the candidate passed filter 3

### Edge Case — per-cell density vs. union density

- **Setup:** Two fingerprints: `makeFingerprint({ cell: 'DeFi & Yield', primarySignals: [{ term: 'TVL', weight: 1.2 }, { term: 'flash loan', weight: 2.0 }], antiSignals: [] })` and `makeFingerprint({ cell: 'Trading', primarySignals: [{ term: 'AMM', weight: 1.0 }, { term: 'DEX', weight: 1.0 }], antiSignals: [] })`. Tweet: `makeTweet({ text: 'we raised $5M seed round TVL AMM', authorBio: undefined })` — union has 2 primary signal matches (passes filter 3 with `densityThreshold: 2`), but DeFi & Yield has only 1 match ('TVL') and Trading has only 1 match ('AMM') — neither cell reaches `densityThreshold: 2` individually. `makeResolver()`.
- **Input:** `makeSource({ fingerprints: [fp1, fp2], xClient: makeXApiClient([tweet]), resolver, config: { searchQuery: '...', densityThreshold: 2 } }).pollOnce()`
- **Expected Output:** resolves to `[CompanyCandidate]` with `matchedCells: []`
- **Assertions:**
  - `result.length === 1`
  - `result[0].matchedCells.length === 0`
  - `result[0].matchedPrimarySignals.length === 2`

---

## AC-012: CompanyCandidate.resolvedCompany.websiteUrl equals the value returned by the resolver

### Happy Path — resolver output mapped faithfully

- **Setup:** `makeResolver({ websiteUrl: 'https://protocol.xyz', name: 'Protocol XYZ' })`. `makeSource({ resolver: ... })`.
- **Input:** `source.pollOnce()`
- **Expected Output:** `result[0].resolvedCompany.websiteUrl === 'https://protocol.xyz'`
- **Assertions:**
  - `result[0].resolvedCompany.websiteUrl === 'https://protocol.xyz'`
  - `result[0].resolvedCompany.name === 'Protocol XYZ'`

---

## AC-013: CompanyCandidate.discoveredAt is a valid ISO 8601 string at or after the pre-call timestamp

### Happy Path — discoveredAt set at candidate construction time

- **Setup:** `makeSource()`. Record `preCallTime = new Date()` before calling `pollOnce()`.
- **Input:** `source.pollOnce()`
- **Expected Output:** `result[0].discoveredAt` is a non-empty ISO 8601 string; `new Date(result[0].discoveredAt) >= preCallTime`
- **Assertions:**
  - `result[0].discoveredAt` is a non-empty string
  - `new Date(result[0].discoveredAt).getTime()` does not return `NaN`
  - `new Date(result[0].discoveredAt) >= preCallTime`

---

## AC-014: XRateLimitError thrown by XApiClient propagates from pollOnce() without retry

### Edge Case — dumb worker; rate limit propagated as-is

- **Setup:** `makeXApiClient('throw:XRateLimitError')` — `searchRecentTweets()` throws `XRateLimitError`. `makeSource({ xClient: ... })`.
- **Input:** `source.pollOnce()`
- **Expected Output:** rejects with `XRateLimitError`
- **Assertions:**
  - Thrown error is an instance of `XRateLimitError`
  - Thrown error is an instance of `XSignalSourceError`

---

## AC-015: XAuthError thrown by XApiClient propagates from pollOnce() without retry

### Edge Case — dumb worker; auth error propagated as-is

- **Setup:** `makeXApiClient('throw:XAuthError')` — `searchRecentTweets()` throws `XAuthError`. `makeSource({ xClient: ... })`.
- **Input:** `source.pollOnce()`
- **Expected Output:** rejects with `XAuthError`
- **Assertions:**
  - Thrown error is an instance of `XAuthError`

---

## AC-016: XNetworkError thrown by XApiClient propagates from pollOnce() without retry

### Edge Case — dumb worker; network error propagated as-is

- **Setup:** `makeXApiClient('throw:XNetworkError')` — `searchRecentTweets()` throws `XNetworkError`. `makeSource({ xClient: ... })`.
- **Input:** `source.pollOnce()`
- **Expected Output:** rejects with `XNetworkError`
- **Assertions:**
  - Thrown error is an instance of `XNetworkError`

---

## AC-017: Resolver returning null drops the tweet silently; pollOnce() does not throw

### Edge Case — company unresolvable; no error

- **Setup:** `makeXApiClient([makeTweet()])` (tweet passes filters 1-3). `makeResolver(null)`. `makeSource({ resolver: ..., xClient: ... })`.
- **Input:** `source.pollOnce()`
- **Expected Output:** resolves to `[]`
- **Assertions:**
  - `result.length === 0`

---

## AC-018: An error thrown by CompanyResolver.resolve() propagates from pollOnce()

### Edge Case — dumb worker; resolver error propagated as-is

- **Setup:** `makeXApiClient([makeTweet()])` (tweet passes filters 1-3). `makeResolver('throw')` — resolver throws a generic `Error`. `makeSource({ resolver: ..., xClient: ... })`.
- **Input:** `source.pollOnce()`
- **Expected Output:** rejects with an error
- **Assertions:**
  - `pollOnce()` rejects (throws)

---

## AC-019: Same tweet.id appearing twice in one poll produces one CompanyCandidate

### Edge Case — within-poll tweetId deduplication

- **Setup:** `makeXApiClient([makeTweet({ id: 'dup-1' }), makeTweet({ id: 'dup-1' })])` — same id twice. `makeSource({ xClient: ... })`.
- **Input:** `source.pollOnce()`
- **Expected Output:** resolves to an array of length 1
- **Assertions:**
  - `result.length === 1`
  - `result[0].tweetId === 'dup-1'`

---

## AC-020: Two distinct tweets resolving to the same websiteUrl each produce a separate CompanyCandidate

### Happy Path — company-URL deduplication is not performed by this module

- **Setup:** `makeXApiClient([makeTweet({ id: 'tweet-1', authorHandle: '@alice' }), makeTweet({ id: 'tweet-2', authorHandle: '@bob' })])`. `makeResolver({ websiteUrl: 'https://same-company.io' })` — resolver returns the same URL for both. `makeSource({ xClient: ..., resolver: ... })`.
- **Input:** `source.pollOnce()`
- **Expected Output:** resolves to an array of length 2
- **Assertions:**
  - `result.length === 2`
  - `result[0].tweetId === 'tweet-1'`
  - `result[1].tweetId === 'tweet-2'`
  - Both have `resolvedCompany.websiteUrl === 'https://same-company.io'`

---

## AC-021: Stub XApiClient enables full filter-pipeline testing without real HTTP calls

### Happy Path — dependency injection wiring

- **Setup:** `makeXApiClient([makeTweet()])` — a controlled stub. `makeSource({ xClient: stub })`.
- **Input:** `source.pollOnce()`
- **Expected Output:** resolves without making any real HTTP requests; `searchRecentTweets()` on the stub was called exactly once
- **Assertions:**
  - `result.length === 1`
  - The stub `searchRecentTweets()` was called (use spy/mock verification)

---

## AC-022: Replacing injected fingerprints changes which tweets pass filters 2 and 3

### Happy Path — vocabulary is derived exclusively from injected fingerprints

- **Setup:** `makeTweet({ text: 'we raised $5M seed round TVL flash loan', authorBio: undefined })`. Two test runs:
  - Run A: `makeFingerprint({ primarySignals: [{ term: 'TVL', weight: 1.2 }], antiSignals: [] })`. `densityThreshold: 1`. Expected: tweet passes.
  - Run B: `makeFingerprint({ primarySignals: [{ term: 'AMM', weight: 1.0 }], antiSignals: [] })`. `densityThreshold: 1`. Expected: tweet fails filter 3 ('TVL' not in this fingerprint's signals, 'AMM' not in tweet).
- **Input (Run A):** `makeSource({ fingerprints: [fingerprintA], xClient: makeXApiClient([tweet]) }).pollOnce()`
- **Input (Run B):** `makeSource({ fingerprints: [fingerprintB], xClient: makeXApiClient([tweet]) }).pollOnce()`
- **Assertions:**
  - Run A: `result.length === 1`
  - Run B: `result.length === 0`

---

## AC-023: densityThreshold defaults to 1 when not specified in config

### Happy Path — default threshold

- **Setup:** `makeTweet({ text: 'we raised $5M seed round multisig', authorBio: undefined })` — exactly one primary signal term. `makeFingerprint({ primarySignals: [{ term: 'multisig', weight: 1.5 }], antiSignals: [] })`. Config with no `densityThreshold` field.
- **Input:** `makeSource({ config: { searchQuery: 'seed round' } /* no densityThreshold */ }).pollOnce()`
- **Expected Output:** resolves to `[CompanyCandidate]` — one match at threshold 1
- **Assertions:**
  - `result.length === 1`

---

## AC-024: densityThreshold: 2 requires at least two distinct primary signal matches

### Edge Case — configurable threshold boundary

- **Setup:** `makeFingerprint({ primarySignals: [{ term: 'multisig', weight: 1.5 }, { term: 'defi', weight: 1.0 }], antiSignals: [] })`. `config: { searchQuery: '...', densityThreshold: 2 }`. Two tweets:
  - Tweet A: `makeTweet({ id: 'a', text: 'we raised $5M seed round multisig' })` — one primary signal term.
  - Tweet B: `makeTweet({ id: 'b', text: 'we raised $5M seed round multisig defi' })` — two primary signal terms.
- **Input (Tweet A):** `makeSource({ xClient: makeXApiClient([tweetA]), ... }).pollOnce()`
- **Input (Tweet B):** `makeSource({ xClient: makeXApiClient([tweetB]), ... }).pollOnce()`
- **Assertions:**
  - Tweet A: `result.length === 0`
  - Tweet B: `result.length === 1`

---

## AC-025: matchesTemplates('') returns []; matchesTemplates with a template phrase returns a non-empty array

### Happy Path — pure function direct test

- **Input (empty):** `matchesTemplates('')`
- **Expected Output:** `[]`
- **Input (matching):** `matchesTemplates('we raised $5M seed round')`
- **Expected Output:** non-empty array containing at least one funding template phrase
- **Assertions:**
  - `matchesTemplates('').length === 0`
  - `matchesTemplates('we raised $5M seed round').length >= 1`
  - `matchesTemplates('we raised $5M seed round')` contains at least one of the known template phrases (e.g., `'seed round'` or `'raised $'`)

---

## AC-026: detectAntiVocab() returns the matched term when it appears only in bio

### Edge Case — bio surface checked independently

- **Input:** `detectAntiVocab('we raised $5M seed round multisig defi', 'wen airdrop?', [{ term: 'airdrop', weight: 1.0 }])`
- **Expected Output:** `'airdrop'`
- **Assertions:**
  - Result is `'airdrop'` (the matched term string)
  - Result is not `null`

---

## AC-027: matchPrimarySignals() returns only terms present in text or bio; absent terms are excluded

### Happy Path — pure function correctness

- **Input:** `matchPrimarySignals('we raised $5M seed round DeFi', 'building infrastructure', [{ term: 'defi', weight: 1.0 }, { term: 'AMM', weight: 1.5 }, { term: 'infrastructure', weight: 1.0 }])` — 'defi' in text (case-insensitive), 'infrastructure' in bio, 'AMM' not in either surface.
- **Expected Output:** array containing `'defi'` and `'infrastructure'`; not containing `'AMM'`
- **Assertions:**
  - Result includes `'defi'`
  - Result includes `'infrastructure'`
  - Result does not include `'AMM'`
  - `result.length === 2`

---

## AC-028: pollOnce() returns [] when XApiClient returns no tweets; resolver is not called

### Edge Case — empty upstream response

- **Setup:** `makeXApiClient([])` — returns empty array. Use a resolver spy to verify it is not invoked.
- **Input:** `makeSource({ xClient: ... }).pollOnce()`
- **Expected Output:** resolves to `[]`
- **Assertions:**
  - `result.length === 0`
  - The resolver's `resolve()` method was not called
