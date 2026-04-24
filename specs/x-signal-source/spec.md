# SPEC: X Signal Source
<!-- spec-version: 1.0 -->
<!-- status: forward -->
<!-- signed-by: -->
<!-- date: 2026-04-25 -->
<!-- superseded-by: -->

## 1. Intent

`XSignalSource` is the first internal sub-module of Module A (EnrichmentEngine). It consumes a live X API feed, applies a four-stage pre-filter pipeline (template match → anti-vocabulary exclusion → primary vocabulary density → company resolution), and emits a `CompanyCandidate` stream into the website enrichment queue. Only candidates that pass all four filters reach Firecrawl enrichment; everything else is dropped cheaply before any expensive I/O runs.

**Design posture: dumb worker.** `XSignalSource` surfaces errors from its dependencies without retry, wrapping, or orchestration. All scheduling, backoff, and retry policy belongs in the EnrichmentEngine orchestrator.

**No Zod at the `CompanyCandidate` boundary.** `CompanyCandidate` is an internal TypeScript interface that does not cross a validation boundary. Zod is applied at the `EnrichedProfile` contract boundary (a separate module), not here.

**Pipeline ordering is a load-bearing architectural invariant.** Anti-vocabulary exclusion (filter 2) runs before primary vocabulary density (filter 3). A tweet containing any anti-signal term is rejected unconditionally — regardless of how many primary signal terms are also present. This ordering is expected to drop 80%+ of incoming tweets before any density computation runs. See architecture §7.3.

## 2. Functional Contract

| Operation | Input | Output | Idempotent | Side Effects |
|-----------|-------|--------|------------|--------------|
| `matchesTemplates(text)` | `string` | `string[]` | Yes | None |
| `detectAntiVocab(text, bio, antiSignals)` | `string, string \| undefined, Signal[]` | `string \| null` | Yes | None |
| `matchPrimarySignals(text, bio, primarySignals)` | `string, string \| undefined, Signal[]` | `string[]` | Yes | None |
| `createXSignalSource(deps)` | `XSignalSourceDeps` | `XSignalSource` | Yes | None |
| `XSignalSource.pollOnce(opts?)` | `PollOpts?` | `Promise<CompanyCandidate[]>` | No | Calls `XApiClient.searchRecentTweets()` and `CompanyResolver.resolve()` |

## 3. Interface Contract

> All types are TypeScript interfaces. No Zod schemas are defined in this module. `CompetencyCell` is imported from `src/schema/enrichedProfile.ts`. `ResolvedFingerprint` and `Signal` are imported from the fingerprint module (`src/fingerprint/`); their concrete path will be determined when that module is implemented.

### 3.1 Public Types

```typescript
import type { CompetencyCell } from '../schema/enrichedProfile';
import type { ResolvedFingerprint, Signal } from '../fingerprint/fingerprint';

export interface Tweet {
  id: string;
  text: string;
  authorHandle: string;
  authorBio?: string;
  postedAt: string; // ISO 8601
}

export interface ResolvedCompany {
  websiteUrl: string;
  name?: string;
  xHandle?: string;
}

export interface CompanyCandidate {
  tweetId: string;
  tweetText: string;
  authorHandle: string;
  authorBio?: string;
  postedAt: string;               // ISO 8601 — from Tweet
  matchedTemplates: string[];     // funding template phrases that fired; guaranteed non-empty
  matchedPrimarySignals: string[]; // primary signal terms that matched in text or bio
  matchedCells: CompetencyCell[];  // cells where ≥densityThreshold of that cell's signals fired
  resolvedCompany: ResolvedCompany;
  discoveredAt: string;           // ISO 8601 — set at candidate construction time
}

// Internal; not present on any public output shape.
export type FilterRejectionReason =
  | 'no_template_match'
  | 'anti_vocab_detected'
  | 'insufficient_density'
  | 'company_unresolvable';
```

### 3.2 XApiClient Interface

```typescript
export interface SearchParams {
  query: string;
  maxResults?: number;
  sinceId?: string;
}

export interface XApiClient {
  searchRecentTweets(params: SearchParams): Promise<Tweet[]>;
}
```

### 3.3 CompanyResolver Interface

```typescript
export interface CompanyResolver {
  resolve(authorHandle: string, tweetText: string): Promise<ResolvedCompany | null>;
}
```

`null` signals that the company could not be resolved (filter 4 drops the tweet). A thrown error propagates from `pollOnce()` unmodified.

### 3.4 XSignalSource Interface and Factory

```typescript
export interface XSignalSourceConfig {
  searchQuery: string;
  maxResults?: number;
  densityThreshold?: number; // default: 1
}

export interface XSignalSourceDeps {
  xClient: XApiClient;
  resolver: CompanyResolver;
  fingerprints: ResolvedFingerprint[]; // all cells' resolved fingerprints, pre-loaded
  config: XSignalSourceConfig;
}

export interface PollOpts {
  sinceId?: string;
}

export interface XSignalSource {
  pollOnce(opts?: PollOpts): Promise<CompanyCandidate[]>;
}

export function createXSignalSource(deps: XSignalSourceDeps): XSignalSource
```

### 3.5 Exported Pure Functions

These three functions are exported for isolated unit testing independent of `XSignalSource`:

```typescript
// Returns the subset of hardcoded funding-template phrases found (substring,
// case-insensitive) in `text`. Empty array = no template match.
export function matchesTemplates(text: string): string[];

// Returns the first anti-signal term found (case-insensitive substring) in
// `text` or `bio`. Checks text first, then bio. Returns null if none found.
export function detectAntiVocab(
  text: string,
  bio: string | undefined,
  antiSignals: Signal[],
): string | null;

// Returns all primary signal terms (case-insensitive substring) found in
// `text` or `bio`. Does not short-circuit; all terms are checked.
export function matchPrimarySignals(
  text: string,
  bio: string | undefined,
  primarySignals: Signal[],
): string[];
```

### 3.6 Error Classes

```typescript
export class XSignalSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XSignalSourceError';
  }
}

export class XRateLimitError extends XSignalSourceError {
  constructor(public readonly retryAfterMs?: number) {
    super('X API rate limit exceeded');
    this.name = 'XRateLimitError';
  }
}

export class XAuthError extends XSignalSourceError {
  constructor() {
    super('X API authentication failed');
    this.name = 'XAuthError';
  }
}

export class XNetworkError extends XSignalSourceError {
  constructor(public readonly cause?: unknown) {
    super('X API network error');
    this.name = 'XNetworkError';
  }
}

export class XResponseError extends XSignalSourceError {
  constructor(public readonly statusCode: number, public readonly body?: unknown) {
    super(`X API returned error status: ${statusCode}`);
    this.name = 'XResponseError';
  }
}
```

All four subclasses are propagated from `pollOnce()` without retry, wrapping, or catch.

## 4. Boundary Contract

### 4.1 Filter Functions

- All three exported filter functions are synchronous and have no I/O, no side effects, and no module-level state.
- `matchesTemplates(text)` — applies hardcoded `FUNDING_SIGNAL_PHRASES` (the same constant pattern established in `src/discovery/XDiscoverySource.ts`) as case-insensitive substring matches against `text`. Returns an array of matched phrase strings. Templates are hardcoded constants in Phase 1; see §6.6.
- `detectAntiVocab(text, bio, antiSignals)` — lowercases both `text` and `bio` (when present) and checks each `antiSignals[i].term` for substring presence. Returns the first matched term string, or `null` if none. Checks `text` before `bio`; short-circuits on first match.
- `matchPrimarySignals(text, bio, primarySignals)` — lowercases both surfaces and checks each `primarySignals[i].term` for substring presence in either. Returns all matched term strings. Does not short-circuit.
- Term matching is case-insensitive substring: `text.toLowerCase().includes(term.toLowerCase())`.

### 4.2 XSignalSource — `pollOnce()` Behavior

**`searchQuery` two-stage pre-filter:** `XSignalSourceConfig.searchQuery` is a broad X API query string that acts as an upstream volume control, limiting which tweets the API returns at all. `matchesTemplates()` is the authoritative strict filter that runs against each returned tweet's full text. A tweet may satisfy the X API query without passing `matchesTemplates()`. This two-stage design is deliberate: the search query manages API-level volume; `matchesTemplates()` enforces funding-announcement semantics.

**Vocabulary union:** At the start of each `pollOnce()` call, two aggregate signal arrays are derived from the injected `fingerprints`:
- `allAntiSignals` — union of `antiSignals` across all `ResolvedFingerprint[]`, deduplicated by `term`.
- `allPrimarySignals` — union of `primarySignals` across all `ResolvedFingerprint[]`, deduplicated by `term`.

**Filter execution order (normative, invariant):** For each tweet returned by `searchRecentTweets()`:

1. `matchesTemplates(tweet.text)` → empty → drop tweet (`'no_template_match'`).
2. `detectAntiVocab(tweet.text, tweet.authorBio, allAntiSignals)` → non-null → drop tweet (`'anti_vocab_detected'`). Runs before step 3 unconditionally.
3. `matchPrimarySignals(tweet.text, tweet.authorBio, allPrimarySignals)` → `matched.length < densityThreshold` → drop tweet (`'insufficient_density'`). The resolver is not called for this tweet.
4. `CompanyResolver.resolve(tweet.authorHandle, tweet.text)` → `null` → drop tweet silently (`'company_unresolvable'`). → throws → propagate immediately.

**`matchedCells` computation:** For each injected `ResolvedFingerprint`, count how many of that fingerprint's own `primarySignals` terms appear in the primary-signal match set from step 3. If the count ≥ `densityThreshold`, that fingerprint's `cell` is included in `matchedCells`. `matchedCells` may be an empty array even when the candidate passed filter 3 on union density — see AC-011.

**`densityThreshold` default:** When `XSignalSourceConfig.densityThreshold` is not specified, it defaults to `1`.

**Deduplication within a poll:** Tweets are deduplicated by `tweet.id` before filter processing. Two occurrences of the same `id` in a single `searchRecentTweets()` response produce at most one `CompanyCandidate`. Company-URL deduplication (two distinct tweets resolving to the same `websiteUrl`) is not performed by this module — each tweet that passes all four filters produces its own `CompanyCandidate`. The EnrichmentEngine orchestrator is responsible for company-level deduplication across polls.

**`sinceId` absent:** When `PollOpts.sinceId` is not provided, `pollOnce()` passes `sinceId: undefined` to `searchRecentTweets()`. The concrete `XApiClient` implementation determines the lookback window; this spec does not constrain that behavior.

**Error propagation:** All errors thrown by `XApiClient.searchRecentTweets()` or `CompanyResolver.resolve()` propagate from `pollOnce()` without catch, wrapping, or retry. No `CompanyCandidate` records are returned when `pollOnce()` throws.

**`discoveredAt`:** Set to `new Date().toISOString()` at the moment each `CompanyCandidate` is constructed (after the resolver returns successfully).

### 4.3 Out-of-Scope Boundaries

- Does NOT call Firecrawl or any website-fetch API.
- Does NOT produce `EnrichedProfile` records.
- Does NOT implement `XApiClient` — the interface is defined here; the concrete HTTP implementation belongs in the `enrichment-engine` spec.
- Does NOT implement `CompanyResolver` — the interface is defined here; the concrete resolver implementation belongs in the `enrichment-engine` spec.
- Does NOT invoke `resolveFingerprint()` — `ResolvedFingerprint[]` is injected already resolved.
- Does NOT make any retry or backoff decision under any error condition.
- Does NOT persist tweets, candidates, or rejection logs to any store.

## 5. Acceptance Criteria

### Filter pipeline order and semantics

- AC-001: When `XApiClient.searchRecentTweets()` returns tweets and none match any funding template, `pollOnce()` returns an empty array.
- AC-002: A tweet matching a funding template AND containing an anti-vocab term (in text or bio) is rejected even when it also contains ≥`densityThreshold` primary signal terms. Anti-vocabulary exclusion runs before and independently of density evaluation.
- AC-003: A tweet matching a template and containing no anti-vocab terms but with fewer than `densityThreshold` primary signal term matches is rejected by filter 3; `CompanyResolver.resolve()` is not called for it.
- AC-004: A tweet passing filters 1-3 for which `CompanyResolver.resolve()` returns `null` is excluded from the output; `pollOnce()` does not throw.
- AC-005: A tweet passing all four filters (template match, no anti-vocab, ≥`densityThreshold` primary signals, resolver returns non-null) produces exactly one `CompanyCandidate` in the output.
- AC-006: `detectAntiVocab()` checks both `tweet.text` and `tweet.authorBio`; an anti-vocab term present only in the bio (not in the tweet text) causes filter 2 rejection.
- AC-007: `matchPrimarySignals()` checks both `tweet.text` and `tweet.authorBio`; a primary signal term present only in the bio contributes to the matched-term count for filter 3.
- AC-008: Anti-vocab terms from all injected `ResolvedFingerprint[]`'s `antiSignals` are combined for filter 2; a term present in any injected fingerprint's `antiSignals` causes rejection.

### CompanyCandidate output shape

- AC-009: `CompanyCandidate.matchedTemplates` contains the text of every funding template phrase that fired on the tweet.
- AC-010: `CompanyCandidate.matchedPrimarySignals` contains every primary signal term that appeared (case-insensitive substring) in the tweet text or author bio, drawn from the union of all injected fingerprints' `primarySignals`.
- AC-011: `CompanyCandidate.matchedCells` contains only `CompetencyCell` values where ≥`densityThreshold` of that cell's own `primarySignals` terms fired in the tweet text or author bio; this may be an empty array even when the candidate passed filter 3 on union density across all fingerprints.
- AC-012: `CompanyCandidate.resolvedCompany.websiteUrl` equals the `websiteUrl` field of the object returned by `CompanyResolver.resolve()`.
- AC-013: `CompanyCandidate.discoveredAt` is a valid ISO 8601 datetime string; its parsed value is at or after the timestamp recorded immediately before `pollOnce()` was called.

### X API and resolver error semantics

- AC-014: `XRateLimitError` thrown by `XApiClient.searchRecentTweets()` is re-thrown from `pollOnce()` without retry, wrapping, or modification.
- AC-015: `XAuthError` thrown by `XApiClient.searchRecentTweets()` is re-thrown from `pollOnce()` without retry, wrapping, or modification.
- AC-016: `XNetworkError` thrown by `XApiClient.searchRecentTweets()` is re-thrown from `pollOnce()` without retry, wrapping, or modification.
- AC-017: When `CompanyResolver.resolve()` returns `null` for a tweet, that tweet is excluded from the output and `pollOnce()` does not throw; remaining tweets in the batch continue through the pipeline.
- AC-018: An error thrown by `CompanyResolver.resolve()` propagates from `pollOnce()` without retry or wrapping.

### Deduplication

- AC-019: When the same `tweet.id` appears more than once in the array returned by `XApiClient.searchRecentTweets()`, the output contains at most one `CompanyCandidate` for that `id`.
- AC-020: When two tweets with distinct `id` values both resolve to the same `resolvedCompany.websiteUrl`, `pollOnce()` returns a separate `CompanyCandidate` for each.

### Dependency injection and config

- AC-021: `createXSignalSource()` accepts `XApiClient`, `CompanyResolver`, `ResolvedFingerprint[]`, and `XSignalSourceConfig` as injected dependencies; a stub `XApiClient` returning controlled tweet arrays enables full filter-pipeline testing without real X API calls.
- AC-022: The vocabulary used for filters 2 and 3 derives entirely from the `fingerprints` injected at construction; replacing the injected fingerprints with different vocabulary changes which tweets pass those filters.
- AC-023: When `XSignalSourceConfig.densityThreshold` is not specified, it defaults to `1`; a tweet with exactly one primary signal match passes filter 3.
- AC-024: When `XSignalSourceConfig.densityThreshold` is `2`, a tweet with exactly one primary signal match is rejected by filter 3; a tweet with two or more distinct primary signal matches passes.

### Pure filter function unit tests

- AC-025: `matchesTemplates('')` returns an empty array; `matchesTemplates('we raised $5M seed round')` returns a non-empty array containing at least one matched template phrase.
- AC-026: `detectAntiVocab()` returns the matched term when the term appears in the `bio` argument but not in the `text` argument.
- AC-027: `matchPrimarySignals()` returns only terms from `primarySignals` that appear (case-insensitive substring) in `text` or `bio`; terms not present in either surface are absent from the result.
- AC-028: `pollOnce()` returns an empty array when `XApiClient.searchRecentTweets()` returns an empty array; `CompanyResolver.resolve()` is not called.

## 6. MVA Constraints

### 6.1 Security Boundaries

- Funding-announcement template phrases are hardcoded constants, not user-controlled. No regex injection risk.
- `XSignalSourceConfig.searchQuery` is passed as an opaque string to `XApiClient`; this module performs no interpolation or eval on it.
- Anti-vocab and density filtering use case-insensitive substring checks against hardcoded or fingerprint-sourced terms. No user-controlled regex, no eval.
- `CompanyCandidate.tweetText` carries raw user-generated content from the X API. Callers must treat it as untrusted before any downstream display or processing.

### 6.2 Resource Ceilings

- `pollOnce()` calls `searchRecentTweets()` exactly once per invocation.
- `CompanyResolver.resolve()` is called at most once per tweet that passes filters 1-3; never for rejected tweets.
- Vocabulary union computation is O(n) on total signal count across all injected fingerprints; computed once per `pollOnce()` call.
- Filter operations are O(m × n) where m = tweet count, n = total vocabulary size. Both are bounded at Phase 1 volumes (expected ≤100 tweets per poll, ≤200 vocabulary terms).
- No persistent state, no caching, no background workers, no connection pooling.

### 6.3 Failure Modes and Degradation

- `XRateLimitError` → propagated; the EnrichmentEngine orchestrator is responsible for back-off.
- `XAuthError` → propagated; indicates credential misconfiguration; requires human intervention.
- `XNetworkError` → propagated; transient failure; orchestrator decides retry policy.
- `XResponseError` → propagated; unexpected API status; orchestrator logs and decides.
- `CompanyResolver.resolve()` returns `null` → tweet silently dropped; expected behavior, not an error.
- `CompanyResolver.resolve()` throws → propagated; error class depends on the resolver implementation.
- No partial results: `pollOnce()` returns a complete `CompanyCandidate[]` or throws. No `undefined` returns.

### 6.4 Rollback and Kill Switch

- `createXSignalSource()` is a factory; replacing it with a no-op that returns `{ pollOnce: async () => [] }` in the orchestrator is the kill switch. No persistence to clean up.
- Template phrases are hardcoded constants; changing them requires a code deploy. No runtime toggle in Phase 1.
- No feature flags in Phase 1.

### 6.5 Observability

- No internal logging in v1.0. Observability is the orchestrator's responsibility.
- Thrown error classes carry structured metadata (`retryAfterMs`, `statusCode`, `body`) for use by the orchestrator's error handler or log formatter.

### 6.6 Phase 2 Deferrals

- **Template configurability** — funding-announcement templates are hardcoded constants in Phase 1, matching the pattern in `src/discovery/XDiscoverySource.ts`'s `FUNDING_SIGNAL_PHRASES`. Making templates runtime-configurable (e.g., loaded from `XSignalSourceConfig` or a JSON file) is explicitly deferred.
- **XApiClient implementation** — the concrete HTTP client that calls the X API Basic tier endpoint is deferred to the `enrichment-engine` spec.
- **CompanyResolver implementation** — the concrete resolver (URL extraction from tweet text, handle lookup) is deferred to the `enrichment-engine` spec.
- **Retry and backoff orchestration** — all retry, backoff, and scheduling logic belongs in the EnrichmentEngine orchestrator, not in this module.
- **Cross-poll company deduplication** — same company surfaced across multiple `pollOnce()` calls is the orchestrator's responsibility.
- **`Tweet` interface boundary note** — The `Tweet` interface is module-local to `src/enrichment/x-signal/`. The legacy `TweetPayload` in `src/discovery/XDiscoverySource.ts` is a separate type for the pre-existing discovery module and is not affected by this spec.

## 7. Test Scaffold Reference

See: specs/x-signal-source/test-scaffold.md
