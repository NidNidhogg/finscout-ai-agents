# SPEC: Enrichment Engine
<!-- spec-version: 1.0 -->
<!-- status: forward -->
<!-- signed-by: -->
<!-- date: 2026-04-29 -->
<!-- superseded-by: -->

## 1. Intent

The Enrichment Engine is the orchestrator of Module A in the FinScout discovery pipeline. It receives `CompanyCandidate` records produced by `XSignalSource`, dispatches each to `WebsiteEnricher` for page-based extraction, and passes the combined signals to `ProfileComposer` for final assembly. The output is an `EnrichedProfile` record ready for the review queue.

**Design posture: orchestrator owns retry and deduplication.** `XSignalSource` is a dumb worker that re-throws errors without retry. All scheduling, rate-limit response, cross-poll deduplication, and backoff decisions live in this module.

**Phase 1 extraction is deterministic.** `WebsiteEnricher` runs keyword and pattern matching against crawled markdown. LLM-based extraction is explicitly deferred to Phase 2.

**Scope boundary.** This spec covers three internal components:
- The `EnrichmentEngine` orchestrator (connects X Signal → Website Enrichment → Profile Composer).
- `WebsiteEnricher` (the boundary for the `PageFetcher` dependency).
- `ProfileComposer` (maps raw signals to the `EnrichedProfile` shape).

`XSignalSource` is covered in `specs/x-signal-source/spec.md`. The `EnrichedProfile` output contract is covered in `specs/enriched-profile/spec.md`. The `ResolvedFingerprint` runtime type is covered in `specs/fingerprint/spec.md`.

---

## 2. Functional Contract

| Operation | Input | Output | Idempotent | Side Effects |
|-----------|-------|--------|------------|--------------|
| `createEnrichmentEngine(deps)` | `EnrichmentEngineDeps` | `EnrichmentEngine` | Yes | None |
| `EnrichmentEngine.enrich(candidate)` | `CompanyCandidate` | `Promise<EnrichedProfile>` | No | Calls `WebsiteEnricher.enrich()`, `ProfileComposer.compose()` |
| `EnrichmentEngine.run(opts?)` | `PollOpts?` | `Promise<EnrichmentRunResult>` | No | Calls `XSignalSource.pollOnce()`, one `enrich()` per deduplicated candidate |
| `createWebsiteEnricher(deps)` | `WebsiteEnricherDeps` | `WebsiteEnricher` | Yes | None |
| `WebsiteEnricher.enrich(websiteUrl)` | `string` | `Promise<WebsiteEnrichmentData>` | No | Calls `PageFetcher.crawl()` |
| `createProfileComposer(coreSignals)` | `Signal[]` | `ProfileComposer` | Yes | None |
| `ProfileComposer.compose(candidate, websiteData, fingerprints)` | three args | `EnrichedProfile` | Yes | Calls `EnrichedProfileSchema.parse()` |

---

## 3. Interface Contract

> All types are TypeScript interfaces unless noted as Zod schemas. `Signal` and `ResolvedFingerprint` are imported from the fingerprint module (`src/fingerprint/`). `CompanyCandidate`, `PollOpts`, and X error classes are imported from `src/enrichment/x-signal/`. `EnrichedProfile`, `EnrichedProfileSchema`, and `FundingStage` are imported from `src/schema/enrichedProfile.ts`. No Zod schemas are defined in this module; `EnrichedProfileSchema.parse()` is called at the ProfileComposer boundary only.

### 3.1 PageFetcher (locked normatively from architecture §7.5)

```typescript
export interface FetchOpts {
  timeoutMs?: number;
}

export interface CrawlOpts {
  maxPages?: number;
  timeoutMs?: number;
  includePaths?: string[];
}

export interface FetchedPage {
  url: string;
  markdown: string;       // cleaned, LLM-ready
  title: string;
  metadata: Record<string, unknown>;
  fetchedAt: Date;
}

export interface PageFetcher {
  fetch(url: string, opts?: FetchOpts): Promise<FetchedPage>;
  crawl(baseUrl: string, opts?: CrawlOpts): Promise<FetchedPage[]>;
}
```

**Concrete Phase 1 implementations:**

- `FirecrawlFetcher` — production path; wraps the Firecrawl Node SDK; maps SDK responses to `FetchedPage`.
- `FixturePageFetcher` — test path; loads `FetchedPage` JSON fixtures from `data/fixtures/pages/<hostname>/<path>.json`. `crawl()` returns all fixture files found under `<hostname>/`; absent fixtures return an empty array. See §4.4 for path conventions.

### 3.2 WebsiteEnricher

```typescript
export interface ExtractedProductData {
  description?: string;           // from /about or homepage
  selfClaimedCategory?: string;   // e.g. "stablecoin infrastructure"
  stackMentions: string[];
  architectureTerms: string[];
  antiSignalTerms: string[];
  evidence: Array<{
    page: string;                  // URL string
    snippet: string;
    relevance: 'high' | 'medium' | 'low';
  }>;
}

export interface ExtractedTeamData {
  estimatedHeadcount?: number;
  headcountSource?: 'about_page' | 'careers_count' | 'unknown';
  founders: Array<{
    name?: string;
    role?: string;
    xHandle?: string;
    linkedinUrl?: string;
    bioSnippet?: string;
    isFoundingEngineer?: boolean;
  }>;
  openRoles: Array<{
    title: string;
    stackHints: string[];
    seniority?: 'junior' | 'mid' | 'senior' | 'lead';
  }>;
}

export interface ExtractedFundingData {
  amountUSD?: number;
  stage?: FundingStage;
  claimedAt?: string;         // ISO 8601
  announcementUrl?: string;
  rawText?: string;
}

export interface WebsiteEnrichmentData {
  pagesFetched: FetchedPage[];
  websiteMarkdown: Record<string, string>;  // url → markdown
  extractedProduct: ExtractedProductData;
  extractedTeam: ExtractedTeamData;
  extractedFunding?: ExtractedFundingData;   // optional — not consumed by ProfileComposer in Phase 1
}

export interface WebsiteEnricherDeps {
  pageFetcher: PageFetcher;
}

export interface WebsiteEnricher {
  enrich(websiteUrl: string): Promise<WebsiteEnrichmentData>;
}

export function createWebsiteEnricher(deps: WebsiteEnricherDeps): WebsiteEnricher;
```

### 3.3 ProfileComposer

```typescript
export interface ProfileComposer {
  compose(
    candidate: CompanyCandidate,
    websiteData: WebsiteEnrichmentData | null,
    fingerprints: ResolvedFingerprint[],
  ): EnrichedProfile;
}

export function createProfileComposer(coreSignals: Signal[]): ProfileComposer;
```

`coreSignals` is the `primarySignals` array from the parsed `core-web3-signals.json` file, validated and passed by the caller. The factory captures this array in the composer's closure. `compose()` uses it to partition matched terms into `matchedCoreSignals` (terms present in `coreSignals`) versus cell-specific signals when computing `product.competencyCellMatches`. The composer does not read files — the caller owns file I/O and validation.

`compose()` is **synchronous**. All I/O is completed before calling it; composition is pure computation.

### 3.4 EnrichmentEngine (Orchestrator)

```typescript
export interface EnrichmentRunResult {
  profilesEnriched: EnrichedProfile[];
  failedCandidates: Array<{ candidate: CompanyCandidate; error: unknown }>;
  status: 'ok' | 'rate_limited' | 'auth_error' | 'network_error';
  retryAfterMs?: number;    // present only when status === 'rate_limited'
}

export interface EnrichmentEngineDeps {
  xSignalSource: XSignalSource;
  websiteEnricher: WebsiteEnricher;
  profileComposer: ProfileComposer;
  fingerprints: ResolvedFingerprint[];
}

export interface EnrichmentEngine {
  enrich(candidate: CompanyCandidate): Promise<EnrichedProfile>;
  run(opts?: PollOpts): Promise<EnrichmentRunResult>;
}

export function createEnrichmentEngine(deps: EnrichmentEngineDeps): EnrichmentEngine;
```

### 3.5 Error Classes

```typescript
export class EnrichmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnrichmentError';
  }
}

export class WebsiteEnrichmentError extends EnrichmentError {
  constructor(
    public readonly websiteUrl: string,
    public readonly cause?: unknown,
  ) {
    super(`Website enrichment failed for: ${websiteUrl}`);
    this.name = 'WebsiteEnrichmentError';
  }
}

export class PageFetchTimeoutError extends WebsiteEnrichmentError {
  constructor(websiteUrl: string) {
    super(websiteUrl);
    this.name = 'PageFetchTimeoutError';
  }
}

export class PageFetchNetworkError extends WebsiteEnrichmentError {
  constructor(websiteUrl: string, cause?: unknown) {
    super(websiteUrl, cause);
    this.name = 'PageFetchNetworkError';
  }
}

export class ProfileComposerError extends EnrichmentError {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ProfileComposerError';
  }
}
```

---

## 4. Boundary Contract

### 4.1 EnrichmentEngine

- Calls `xSignalSource.pollOnce()` exactly once per `run()` invocation.
- Deduplicates candidates by `resolvedCompany.websiteUrl` within a single `run()` invocation; when two candidates share the same URL, the first occurrence proceeds to enrichment and subsequent duplicates are silently dropped. Cross-poll deduplication is the persistence layer's responsibility.
- Catches `XRateLimitError` from `pollOnce()`; returns `{ status: 'rate_limited', retryAfterMs: err.retryAfterMs, profilesEnriched: [], failedCandidates: [] }`. Does not re-throw.
- Propagates `XAuthError` and `XNetworkError` from `pollOnce()` without catch. These indicate conditions requiring human intervention or caller-side retry.
- Catches `WebsiteEnrichmentError` from `enrich()`; calls `compose(candidate, null, fingerprints)` and includes the partial profile in `profilesEnriched`.
- Propagates `ProfileComposerError` from `compose()` without catch; records the failed candidate in `failedCandidates`.
- Does NOT implement retry, scheduling, polling intervals, or backoff.
- Does NOT persist `EnrichedProfile` records; the caller is responsible for persistence.
- Does NOT call `EnrichedProfileSchema.parse()`; that is the ProfileComposer's responsibility.

### 4.2 WebsiteEnricher

- Calls `PageFetcher.crawl(websiteUrl)` exactly once per `enrich()` invocation. Does not import or call any Firecrawl SDK method directly.
- Runs deterministic pattern extractors against `FetchedPage.markdown` content. No network calls beyond `PageFetcher.crawl()`.
- Includes all pages returned by `crawl()` in `pagesFetched`, including pages with empty markdown strings.
- Throws `PageFetchTimeoutError` when `PageFetcher.crawl()` throws a timeout error.
- Throws `PageFetchNetworkError` for all other `PageFetcher.crawl()` errors.
- Does NOT validate its return value against any Zod schema.
- Does NOT populate `extractedFunding`; the field is optional and its value is not consumed by `ProfileComposer` in Phase 1. Full website-based funding extraction is deferred to Phase 2.

### 4.3 ProfileComposer

- Pure computation: synchronous, no I/O, no side effects.
- Accepts `coreSignals: Signal[]` at construction via `createProfileComposer()`; does not read files.
- `compose()` with `websiteData: null` produces a valid `EnrichedProfile` with empty arrays for all website-derived fields. The profile is shaped for the reviewer to tag `missing_tech_stack`, `missing_architecture_signal`, or similar evidence-type gaps.
- Sets `schemaVersion: "1.0.0"` unconditionally.
- Sets `enrichedAt` to `new Date().toISOString()` at composition time.
- Sets `id` to a freshly generated UUID (v4) at composition time.
- Sets `company.name` to `resolvedCompany.name` when present; falls back to the `authorHandle` with the leading `@` stripped and first letter uppercased. If `resolvedCompany.name` is absent AND the stripped `authorHandle` is empty or blank after stripping, throws `ProfileComposerError('missing company name source')`.
- Sets `company.normalizedName` to the lowercase, whitespace-normalized form of `company.name`.
- Sets `sources.xApi.tweetsConsidered: 1` unconditionally (Phase 1 — one tweet per candidate).
- Computes `matchedCoreSignals` by intersecting matched terms against the `coreSignals` array injected at construction (comparison by `term` string, case-insensitive).
- Computes `score` as `matchedTermCount / totalCellTermCount`; returns `0` when `totalCellTermCount` is `0`.
- Does NOT set `funding.confirmed` (reviewer fills this during the review queue workflow).
- Does NOT set `company.country` (no automated geo-resolution in Phase 1).
- Does NOT set `company.linkedinUrl` (no LinkedIn enrichment in Phase 1).
- Calls `EnrichedProfileSchema.parse()` before returning; throws `ProfileComposerError` wrapping the `ZodError` as `cause` if validation fails.

### 4.4 FixturePageFetcher

- Loads `FetchedPage` objects from `data/fixtures/pages/<hostname>/<path>.json`.
  - `<hostname>` is derived from the URL's `hostname` (e.g., `example.com`).
  - `<path>` is derived from the URL path: `/about` → `about.json`; `/` → `index.json`; `/careers/engineering` → `careers-engineering.json` (slashes normalized to hyphens, leading slash stripped).
- `crawl(baseUrl)` reads all `.json` files present under `data/fixtures/pages/<hostname>/` and deserializes them as `FetchedPage[]`. If the hostname directory does not exist, returns `[]` without throwing.
- `fetch(url)` returns the single matching fixture file; throws if the fixture is absent (callers using `fetch()` directly expect a result).
- Each fixture file is a plain JSON object matching the `FetchedPage` shape, with `fetchedAt` as an ISO 8601 string that `FixturePageFetcher` deserializes to a `Date`.

---

## 5. Acceptance Criteria

### Group A: Orchestrator Flow

- AC-001: `createEnrichmentEngine()` accepts `XSignalSource`, `WebsiteEnricher`, `ProfileComposer`, and `ResolvedFingerprint[]` as injected dependencies; a stub `XSignalSource` returning controlled `CompanyCandidate[]` enables full pipeline testing without real X API calls.
- AC-002: `enrich(candidate)` calls `WebsiteEnricher.enrich()` with `candidate.resolvedCompany.websiteUrl`, then calls `ProfileComposer.compose(candidate, websiteData, fingerprints)`, and returns the resulting `EnrichedProfile`.
- AC-003: `enrich(candidate)` catches `WebsiteEnrichmentError`, calls `ProfileComposer.compose(candidate, null, fingerprints)`, and returns the partial `EnrichedProfile` without re-throwing the error.
- AC-004: `run()` calls `xSignalSource.pollOnce()` and calls `enrich()` once for each candidate returned.
- AC-005: `run()` deduplicates candidates by `resolvedCompany.websiteUrl` before enrichment; when two candidates share the same URL, exactly one `enrich()` call is made for that URL.
- AC-006: `run()` returns `{ status: 'rate_limited', retryAfterMs: N, profilesEnriched: [], failedCandidates: [] }` when `XRateLimitError` is thrown by `pollOnce()`; no error is re-thrown.
- AC-007: `run()` continues processing remaining candidates when one `enrich()` call throws `ProfileComposerError`; the failed candidate appears in `EnrichmentRunResult.failedCandidates` and other candidates are processed normally.
- AC-008: `run()` returns `{ status: 'ok', profilesEnriched: [...], failedCandidates: [] }` when all candidates enrich successfully.

### Group B: PageFetcher Boundary / Website Enricher

- AC-009: `WebsiteEnricher.enrich()` calls `PageFetcher.crawl()` with the provided website URL; the `WebsiteEnricher` implementation contains no direct import or call of any Firecrawl SDK method.
- AC-010: The returned `WebsiteEnrichmentData.pagesFetched` contains one entry per page successfully returned by `PageFetcher.crawl()`.
- AC-011: `WebsiteEnrichmentData.websiteMarkdown` is a `Record<string, string>` mapping each successfully fetched page URL to its markdown content.
- AC-012: When `PageFetcher.crawl()` returns pages where some entries have empty markdown strings, those pages are included in `pagesFetched` without filtering on content presence.
- AC-013: `WebsiteEnricher.enrich()` throws `PageFetchTimeoutError` when the underlying `PageFetcher.crawl()` throws a timeout error.
- AC-014: `WebsiteEnricher.enrich()` throws `PageFetchNetworkError` when the underlying `PageFetcher.crawl()` throws a non-timeout network error.
- AC-015: `FixturePageFetcher.crawl()` returns deserialized `FetchedPage[]` from `data/fixtures/pages/<hostname>/` for the given URL; when no fixture files exist for that hostname, returns an empty array without throwing.
- AC-016: `WebsiteEnricher` constructed with a `FixturePageFetcher` loaded with controlled markdown returns `WebsiteEnrichmentData` with deterministic extraction results, enabling full enrichment-pipeline assertions in tests without network calls.

### Group C: Profile Composer

- AC-017: `compose()` sets `EnrichedProfile.company.name` to `resolvedCompany.name` when present; when `resolvedCompany.name` is absent, falls back to the `authorHandle` with the leading `@` stripped and the first character uppercased; throws `ProfileComposerError('missing company name source')` when `resolvedCompany.name` is absent AND the stripped `authorHandle` is empty or blank.
- AC-018: `compose()` sets `company.normalizedName` to the lowercase, whitespace-normalized form of `company.name`.
- AC-019: `compose()` sets `company.websiteUrl` from `resolvedCompany.websiteUrl` and `company.xHandle` from `candidate.authorHandle`.
- AC-020: `compose()` sets `sources.xApi.lastFetched` to `candidate.discoveredAt`, `sources.xApi.tweetsConsidered` to `1`, and `sources.xApi.founderHandle` to `candidate.authorHandle`.
- AC-021: `compose()` populates `sources.websiteCrawl` — `lastFetched` from the maximum `fetchedAt` across `websiteData.pagesFetched` (as an ISO string), `pagesCrawled` as the array of page URL strings, and `fetcher: "firecrawl"` — when `websiteData` is non-null; omits `sources.websiteCrawl` entirely when `websiteData` is null.
- AC-022: `compose()` maps `funding.claimed` fields from the candidate: `rawText` from `tweetText`, `templateMatched` from `matchedTemplates`, `claimedAt` from `postedAt`.
- AC-023: `compose()` computes `product.competencyCellMatches` by running each injected `ResolvedFingerprint`'s `primarySignals` terms against the union of `websiteData.extractedProduct.architectureTerms` and `stackMentions`; when `websiteData` is null, runs against `candidate.matchedPrimarySignals` only.
- AC-024: Each `competencyCellMatches[].score` equals `matchedTermCount / totalCellTermCount` as a float in `[0, 1]`; a cell whose fingerprint has zero primary signal terms scores `0`.
- AC-025: `competencyCellMatches[].matchedCoreSignals` contains only terms present in the `coreSignals` array injected at `createProfileComposer()` construction time (comparison by term string, case-insensitive); terms matched from cell-specific signals are absent from this sub-array.
- AC-026: `compose()` populates `product.evidence` from `websiteData.extractedProduct.evidence`, mapping `page`, `snippet`, and `relevance` per entry; when `websiteData` is null, `product.evidence` is an empty array.
- AC-027: `compose()` sets `rawContent.websiteMarkdown` from `websiteData.websiteMarkdown`; when `websiteData` is null, sets it to `{}`.
- AC-028: `compose()` sets `rawContent.sourceTweets` to a single-entry array with `id: candidate.tweetId`, `text: candidate.tweetText`, `postedAt: candidate.postedAt`, `authorHandle: candidate.authorHandle`, and `authorBio: candidate.authorBio`.
- AC-029: `compose()` calls `EnrichedProfileSchema.parse()` on the assembled object before returning; when parse fails, `ProfileComposerError` is thrown with the `ZodError` as `cause`.
- AC-030: `compose()` with `websiteData: null` returns a valid `EnrichedProfile` where `product.stackMentions`, `product.architectureTerms`, `product.antiSignalTerms`, `product.competencyCellMatches`, `product.evidence`, `team.founders`, and `rawContent.websiteMarkdown` are empty (`[]` or `{}`), and `sources.websiteCrawl` is absent.

### Group D: Error Handling & State Transitions

- AC-031: `enrich()` re-throws `ProfileComposerError` without catch; when called from `run()`, the failed candidate is recorded in `EnrichmentRunResult.failedCandidates` and does not appear in `profilesEnriched`.
- AC-032: `XAuthError` thrown by `pollOnce()` propagates from `run()` without catch or wrapping.
- AC-033: `XNetworkError` thrown by `pollOnce()` propagates from `run()` without catch or wrapping.
- AC-034: `run()` returns `{ status: 'ok', profilesEnriched: [], failedCandidates: [] }` when `pollOnce()` returns an empty array; `WebsiteEnricher.enrich()` is not called.
- AC-035: `WebsiteEnrichmentError` caught during `enrich()` does not cause the candidate to appear in `failedCandidates`; the partial `EnrichedProfile` produced by `compose(candidate, null, fingerprints)` appears in `profilesEnriched` instead.

---

## 6. MVA Constraints

### 6.1 Security Boundaries

- All `EnrichedProfile` objects are validated against `EnrichedProfileSchema.parse()` at the ProfileComposer boundary before any downstream consumption. No raw type assertions (`as EnrichedProfile`) at system boundaries.
- `WebsiteEnricher` passes a URL string to `PageFetcher.crawl()`; URL validation is the `PageFetcher` implementation's responsibility. `WebsiteEnricher` does not perform URL rewriting or interpolation.
- Extracted markdown from crawled pages is untrusted text content. No eval, no dynamic import, no SQL interpolation of extracted terms in the extraction layer.
- `coreSignals` injected into `createProfileComposer()` are trusted internal data (Zod-validated by the caller via `CoreFingerprintFileSchema.parse()` before injection).

### 6.2 Resource Ceilings

- `run()` calls `pollOnce()` exactly once per invocation.
- `enrich()` calls `WebsiteEnricher.enrich()` exactly once per candidate.
- `WebsiteEnricher.enrich()` calls `PageFetcher.crawl()` exactly once per invocation.
- `compose()` is O(n × m) on fingerprint vocabulary size × terms extracted; no I/O.
- No persistent state, no caching, no background workers, no connection pooling in any of the three components.

### 6.3 Failure Modes & Degradation

- `XRateLimitError` → caught by `run()`; returns `rate_limited` status. No re-throw.
- `XAuthError` → propagated from `run()`. Requires human credential intervention.
- `XNetworkError` → propagated from `run()`. Transient; caller decides retry.
- `WebsiteEnrichmentError` → caught by `enrich()`; partial profile emitted. Website data is treated as optional enrichment, not a hard prerequisite.
- `PageFetchTimeoutError` / `PageFetchNetworkError` → subtypes of `WebsiteEnrichmentError`; handled identically by the orchestrator.
- `ProfileComposerError` → propagated from `enrich()`. Indicates an implementation bug (assembled shape failed schema validation). Recorded in `failedCandidates`.
- No partial returns from `enrich()`: either a complete `EnrichedProfile` (possibly with absent website fields) or a throw.

### 6.4 Rollback & Kill Switch

- `createEnrichmentEngine()` is a factory; replacing it with a no-op implementation is the kill switch. No persistent state to clean up.
- `schemaVersion: "1.0.0"` is a Zod literal; a version increment requires a code deploy and schema migration.
- No runtime feature flags in Phase 1.

### 6.5 Observability

- No internal logging in v1.0. The `run()` caller is responsible for structured logging of `EnrichmentRunResult` and any propagated errors.
- Thrown error classes carry structured metadata (`websiteUrl`, `cause`, `retryAfterMs`) for the caller's error handler and log formatter.

### 6.6 Phase 2 Deferrals

- **LLM extraction** — Phase 1 uses deterministic pattern matching only. LLM-based content extraction is explicitly deferred.
- **Retry and backoff** — no retry logic in this module. Scheduling belongs in the calling layer (cron runner, queue worker).
- **Cross-poll deduplication** — `run()` deduplicates within a single poll. Same company across two separate invocations is the persistence layer's responsibility.
- **`XApiClient` and `CompanyResolver` concrete implementations** — the HTTP clients for X API Basic tier and company URL resolution are implementation details specified in the implementation phase, not here.
- **Per-page timeout fallback** — when `crawl()` times out, Phase 1 does not attempt per-page `fetch()` retries. Multi-source and fallback-chain fetchers are deferred.
- **Full website-funding extraction** — `ExtractedFundingData` is defined but `extractedFunding` is optional and `ProfileComposer` does NOT consume it in Phase 1. The primary funding source is the X tweet (`candidate.tweetText` / `candidate.matchedTemplates`). Richer website-based funding extraction is a Phase 2 improvement.

---

## 7. Test Scaffold Reference

See: specs/enrichment-engine/test-scaffold.md
