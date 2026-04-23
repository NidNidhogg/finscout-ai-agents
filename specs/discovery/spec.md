# SPEC: XDiscoverySource
<!-- spec-version: 1.0 -->
<!-- status: retroactive -->
<!-- signed-by: -->
<!-- date: 2026-04-23 -->
<!-- superseded-by: -->

## 1. Intent

`XDiscoverySource` extracts lead-discovery signals from raw X (Twitter) tweet payloads and founder profiles. It provides three pure functions: keyword extraction from tweet text, priority scoring of tweets for lead-generation value, and look-alike query construction from founder profiles. The module produces structured signal data consumed by the discovery pipeline to identify early-stage funded companies in FinScout's target sectors.

This is a retroactive specification. The module `src/discovery/XDiscoverySource.ts` and its 18 tests in `src/discovery/XDiscoverySource.test.ts` existed before this spec was written. This document records current behavior and existing test coverage. See §8 for known coverage gaps.

## 2. Functional Contract

| Operation | Input Shape | Output Shape | Idempotent | Side Effects |
|-----------|-------------|--------------|------------|--------------|
| `extractKeywords` | `unknown` (validated as `TweetPayload`) | `ExtractedKeywords` | Yes | None |
| `scoreTweet` | `unknown` (validated as `TweetPayload`) | `ScoredTweet` | Yes | None |
| `buildLookAlikeQuery` | `unknown` (validated as `FounderProfile`) | `LookAlikeQuery` | Yes | None |

## 3. Interface Contract

### `TweetPayload`
```ts
{
  id:        string;  // non-empty
  text:      string;  // non-empty
  authorId:  string;  // non-empty
  createdAt: string;  // ISO 8601 date string
}
```

### `ExtractedKeywords`
```ts
{
  fundingSignals: string[];  // matched funding-signal phrases from tweet text
  sectorKeywords: string[];  // matched sector keywords from tweet text
  all:            string[];  // fundingSignals ++ sectorKeywords (concatenation)
}
```

### `ScoredTweet`
```ts
{
  tweetId:        string;
  priorityScore:  number;
  fundingSignals: string[];
  sectorKeywords: string[];
}
```

### `FounderProfile`
```ts
{
  handle:   string;    // non-empty X handle
  bio:      string;
  keywords: string[];  // explicit seed keywords
}
```

### `LookAlikeQuery`
```ts
{
  keywords:    string[];  // deduplicated union of bio-extracted and explicit keywords
  queryString: string;    // keywords joined with ' OR '; empty string if no keywords
}
```

### Scoring formula (internal constants, not exported)

```
+50  any funding-signal phrase detected in tweet text
+30  any sector keyword detected in tweet text
+20  combo bonus when both funding-signal and sector keyword are present
```

Maximum achievable score: 100 (all three conditions met).

## 4. Boundary Contract

- Does NOT: make network calls; read or write files; persist results; interact with the X API directly.
- Assumes: all input is received as `unknown`; internal Zod validation runs before any processing.
- Depends on: `ValidationError` from `../sales-factory/errors`; `zod` for schema validation.
- If input fails Zod validation: throw `ValidationError` with semicolon-joined field-level messages; do not partially process.
- No side effects: all three exported functions are pure and synchronous.

## 5. Acceptance Criteria

### extractKeywords

- AC-001: Given a tweet whose text contains the phrases `"we raised"` and `"seed round"`, `extractKeywords` must return a `fundingSignals` array containing both `"we raised"` and `"seed round"`.
- AC-002: Given a tweet whose text contains `"thrilled to announce"` and the word `"defi"`, `extractKeywords` must return `fundingSignals` containing `"thrilled to announce"` and `sectorKeywords` containing `"defi"`.
- AC-003: Given a tweet whose text contains no funding-signal phrases and no sector keywords, `extractKeywords` must return `fundingSignals`, `sectorKeywords`, and `all` each as empty arrays.
- AC-004: The `all` field must contain every item from `fundingSignals` and every item from `sectorKeywords`, and its length must equal `fundingSignals.length + sectorKeywords.length`.
- AC-005: Keyword matching must be case-insensitive; a tweet with uppercased text (e.g., `"THRILLED TO ANNOUNCE"`, `"FINTECH"`) must produce the same matched phrases as the equivalent lowercase input.
- AC-006: Given a `TweetPayload` with an invalid `createdAt` value (not a parseable ISO 8601 date string), `extractKeywords` must throw a `ValidationError` whose message references `"createdAt"`.

### scoreTweet

- AC-007: Given a tweet whose text contains both funding-signal phrases and sector keywords, `scoreTweet` must return a `priorityScore` of at least 70.
- AC-008: Given a tweet whose text contains funding-signal phrases but no sector keywords, `scoreTweet` must return a `priorityScore` of exactly 50.
- AC-009: Given a tweet whose text contains sector keywords but no funding-signal phrases, `scoreTweet` must return a `priorityScore` of exactly 30.
- AC-010: Given a tweet whose text contains no funding-signal phrases and no sector keywords, `scoreTweet` must return a `priorityScore` of exactly 0.
- AC-011: The `ScoredTweet` result must carry the source tweet's `id` as `tweetId`, a non-empty `fundingSignals` array, and a `sectorKeywords` array containing the matched sector term.
- AC-012: Given a `TweetPayload` with an invalid `createdAt` value (not a parseable ISO 8601 date string), `scoreTweet` must throw a `ValidationError` whose message references `"createdAt"`.

### buildLookAlikeQuery

- AC-013: Given a `FounderProfile` whose `bio` contains sector keywords (e.g., `"defi"`, `"crypto"`), `buildLookAlikeQuery` must return a `keywords` array containing those sector keywords.
- AC-014: Given a `FounderProfile` with a non-empty `keywords` array, `buildLookAlikeQuery` must include those explicit keywords in the returned `keywords` array.
- AC-015: Given a `FounderProfile` with a bio containing sector keywords and a non-empty `keywords` list, `buildLookAlikeQuery` must return a non-empty `queryString` that contains those keywords and uses `"OR"` as the separator between terms.
- AC-016: If a keyword appears in both the bio and the explicit `keywords` list, `buildLookAlikeQuery` must include it exactly once in the returned `keywords` array.
- AC-017: Given a `FounderProfile` whose `bio` and `keywords` contain no recognized vocabulary, `buildLookAlikeQuery` must return an empty `keywords` array and an empty string `queryString` (`""`).
- AC-018: Given a `FounderProfile` with an empty string `handle`, `buildLookAlikeQuery` must throw a `ValidationError` whose message references `"handle"`.

## 6. MVA Constraints

### 6.1 Security Boundaries

- All inputs to `extractKeywords`, `scoreTweet`, and `buildLookAlikeQuery` are typed as `unknown` and validated with Zod before any processing executes.
- Keyword matching is performed on lowercased tweet text against lowercase constant lists; no user-controlled regex or eval is involved.
- `authorId` and `handle` are treated as opaque strings; no interpolation into queries or commands is performed.

### 6.2 Resource Ceilings

- All three exported functions are pure synchronous functions.
- No network calls, no file I/O, no database access.
- Keyword matching runs in O(n × m) time where n is the number of constant phrases and m is the length of the tweet text; both are bounded at current constant list sizes.

### 6.3 Failure Modes & Degradation

- Invalid input (Zod parse failure): throw `ValidationError` with semicolon-joined field-level messages; do not partially process.
- `createdAt` not parseable as an ISO 8601 date: throw `ValidationError`; do not silently treat as valid.
- No partial results: a function either returns a complete typed result or throws; no undefined returns.

### 6.4 Rollback & Kill Switch

- This module is pure business logic with no persistent state; rollback = deploy previous version.
- No feature flags required for v1.0.

### 6.5 Observability

- No internal logging in v1.0; observability is the responsibility of the calling layer.

## 7. Test Scaffold Reference

See: specs/discovery/test-scaffold.md

## 8. Known Coverage Gaps

The following behaviors are implemented in `src/discovery/XDiscoverySource.ts` but are not covered by any existing test. They are documented here as gaps to be addressed in future testing commits — not as current Acceptance Criteria.

- **Role keyword extraction from bio:** `_extractBioKeywords` extracts `ROLE_KEYWORDS` (`founder`, `builder`, `cto`, `ceo`, `cofounder`, `co-founder`, `engineer`, `developer`, `creator`) from the bio in addition to sector keywords. No existing test verifies that role keywords appear in the `buildLookAlikeQuery` result.
- **Maximum score ceiling:** The `scoreTweet` JSDoc states "Maximum score: 100." No existing test hits the maximum and asserts the 100 ceiling explicitly.
- **Lowercase normalization of explicit keywords:** `buildLookAlikeQuery` lowercases all entries in `profile.keywords` via `.map((k) => k.toLowerCase())`. No existing test supplies uppercase explicit keywords to verify this normalization.
- **Validation of `id`, `text`, and `authorId` fields:** `TweetPayloadSchema` enforces `min(1)` on `id`, `text`, and `authorId`. Existing tests only trigger `ValidationError` via an invalid `createdAt`. Missing-field and empty-field validation for the other three fields is untested.
- **`bio` and `keywords` field validation edge cases:** `FounderProfileSchema` accepts any `string` for `bio` and any `string[]` for `keywords` (no minimum constraints). The only validation test covers `handle`. Boundary behavior for `bio` and `keywords` is untested.
