# FinScout — Architecture Reference

**Module A (Discovery & Enrichment) + Module C (Outreach/HITL) — operational 2026-05-21**

---

## Core Philosophy

### Minimum Viable Architecture (MVA)

Every component exists to serve the current outreach workflow, not a hypothetical future one. Constraints are load-bearing:

- **No message queue.** SQLite is the only store. A queue abstraction (Redis, SQS) introduces ops overhead before signal quality is validated.
- **No async workers.** CLI scripts run synchronously. Parallelism is added only when single-threaded latency blocks a real use case.
- **No ORM.** Raw `better-sqlite3` prepared statements with Zod validation at insert/read boundaries. Schema changes are just SQL.
- **No PDF extraction.** Americanfort's SDK documentation is a PDF. Firecrawl returns a viewer shell. The HTML signals (`Rust`, `cross-chain`, `L2`) extracted from the `/sdk` page are sufficient for Phase 1 outreach. PDF pipeline is in the backlog.

### Founding Sales Methodology

The pipeline applies the *Pain + Authority + Ability to Pay* triad before any lead graduates to outreach:

| Signal leg | Where extracted | Example |
|---|---|---|
| **Ability to Pay** | Tech stack mentions from website crawl | `Rust`, `Solidity`, `Go` |
| **Pain** | Open roles from `/career` page, headcount signal | "Hiring AI Engineer" |
| **Authority** | Founder X handle, bio, profile URL | `@founder`, LinkedIn |

A profile missing all three legs is marked `profileAdequate: false` with the corresponding `missingEvidenceTypes` and does not advance.

---

## 4-Stage Pipeline

The pipeline is structured into four discrete stages, each backed by a dedicated CLI script. All four are chained by the `npm run scout` orchestrator using `&&` — a non-zero exit from any stage halts the chain. Stages are otherwise decoupled: each reads from and writes to the SQLite queue independently.

| Stage | CLI | Input source | Queue transition |
|---|---|---|---|
| **1a — X-Radar** | `fetch-funding.ts` | X API v2 (Web3/DeFi funding tweets) | insert `pending` |
| **1b — DefiLlama** | `fetch-defillama.ts` | DefiLlama API (live TVL data) | insert `pending` |
| **2 — Enrichment** | `enrich-pending.ts` | `pending` + `needs_retry` items | `→ reviewed`, `→ needs_retry`, or `→ discarded` |
| **3 — Generation** | `generate-outreach.ts` | `reviewed` items | `→ drafted` or `→ discarded` |
| **4 — HITL Review** | `review-outreach.ts` | `drafted` items | `→ sent` or `→ discarded` |

The queue item `status` column is the coordination primitive. No message broker required; SQLite `INSERT OR IGNORE` and `UPDATE … WHERE id = ?` provide sufficient concurrency control for single-operator use. This is a deliberate MVA constraint: adding Redis or SQS introduces ops overhead before signal quality is validated.

---

## Data Flow Pipeline

### Step 1 — X API tweet ingestion

**File:** `src/enrichment/x-signal/ConcreteXApiClient.ts`

`GET /2/tweets/search/recent` with:
- `tweet.fields=created_at,author_id`
- `expansions=author_id`
- `user.fields=username,description,url,entities,public_metrics`

The `user.url` field is always a `t.co` short link. The real domain is at `user.entities.url.urls[0].expanded_url`. The client maps `expanded_url` to `tweet.authorProfileUrl` and discards `user.url` entirely.

Rate limit response (`HTTP 429`) is parsed for `retry-after` header and re-thrown as `XRateLimitError(retryAfterMs)`. The engine surfaces this as `status: 'rate_limited'` with the delay — callers retry after the specified interval.

---

### Step 2 — Five-stage filter chain

**File:** `src/enrichment/x-signal/XSignalSource.ts`, `filters.ts`

Filters run cheapest-first. Each filter discards with a labeled reason logged at `DEBUG` level (`f1:no_template_match`, etc.).

| Filter | Function | Discard condition |
|---|---|---|
| **F1** template match | `matchesTemplates()` | Tweet contains none of 19 funding signal phrases (`raised $`, `in funding`, `pre-seed`, `series a`, …) |
| **F2** anti-vocab | `detectAntiVocab()` | Tweet text or author bio contains a known disqualifier (`outsourcing`, `crypto news`, `breaking`, `analytics firm`, …) checked against both core and cell anti-signals |
| **F3** signal density | `matchPrimarySignals()` | Matched primary signal count < `densityThreshold` (default: 1); searches tweet text and author bio |
| **F5** funding threshold | `isBelowFundingThreshold()` | An explicit funding amount is detected AND it is < $1,000,000. Regex parses both `$500k` / `$2M` forms and `500 thousand` / `2 million` prose forms. Tweets with no detectable amount pass. |
| **F4** company resolver | `ConcreteCompanyResolver.resolve()` | Async, runs last (most expensive). Tweet text URLs are checked first; `authorProfileUrl` is the fallback. `t.co`, `twitter.com`, and `x.com` are excluded from both paths. Unresolvable = "lite" candidate (websiteUrl: null), not discarded. |

All five fingerprint cells run in parallel; the vocabulary union across cells is used for F2/F3. Per-cell density is recalculated after filtering to populate `matchedCells` on the candidate.

---

### Step 3 — Idempotency and deduplication

**File:** `src/enrichment/EnrichmentEngine.ts`

Two deduplication layers:

1. **`run()` — candidate dedup before enrichment.** Candidates are keyed by `websiteUrl` (URL-having) or `tweetId:${id}` (URL-less). Duplicate keys are dropped before any Firecrawl call is made.

2. **`engine.enrich()` — in-memory URL guard.** `createEnrichmentEngine` holds a `crawledUrls = new Set<string>()`. If `enrich()` is called a second time with the same URL in the same engine instance, the `websiteEnricher.enrich()` call is skipped and `websiteData` is left `null`.

3. **Test script — cross-run guard.** `test-firecrawl-enrichment.ts` checks `profile.sources.websiteCrawl?.lastFetched` before invoking the enricher. If a crawl timestamp exists from a previous run, the profile is skipped entirely — no Firecrawl API credit consumed.

---

### Step 4 — Two-phase Firecrawl deep crawl

**File:** `src/enrichment/website/FirecrawlFetcher.ts`, `EnrichmentEngine.ts`

**Phase 1 — doc/SDK priority:**

```
POST /v1/crawl
{
  "url": "<baseUrl>",
  "limit": 5,
  "includePaths": ["doc", "sdk", "developer", "api", "wiki"],
  "excludePaths": [".pdf", "whitepaper"],
  "scrapeOptions": { "formats": ["markdown"] }
}
→ { "success": true, "id": "<jobId>" }
```

`excludePaths` prevents the crawler from wasting page slots on PDF viewer shells (a common pattern on Web3 project sites where whitepapers are embedded PDFs).

**Phase 2 — unrestricted fallback:**

If Phase 1 returns ≤ 1 page (site has no doc/sdk paths), the enricher retries without `includePaths`, keeping only `excludePaths`. This preserves signal-rich pages (press releases, careers, about) for consumer-facing sites like PIN AI that have no developer documentation.

**Polling:**

Firecrawl's `/v1/crawl` is asynchronous. The fetcher polls `GET /v1/crawl/{jobId}` until `status === 'completed'` or `failed` / `cancelled`, up to 30 attempts. `pollIntervalMs` defaults to 2,000ms (configurable in constructor for tests: set to `0`).

**URL-less candidates:**

If `resolvedCompany.websiteUrl` is `null`, `WebsiteEnricher` is not called at all. The `ProfileComposer` assembles a "lite" profile using only X signal data (tweet text, author bio, matched terms). This is valid — some founders announce funding without including a URL in the tweet.

---

### Step 5 — Signal extraction

**File:** `src/enrichment/EnrichmentEngine.ts` (`extractArchitectureTerms`, `extractStackMentions`)

Concatenated markdown from all crawled pages is scanned against two in-memory vocabulary lists:

**Architecture vocabulary (30 terms):** `multisig`, `stablecoin`, `smart contract`, `zero knowledge`, `zk-proof`, `zkp`, `merkle`, `settlement`, `custody`, `vesting`, `validator`, `oracle`, `amm`, `dex`, `tvl`, `flash loan`, `bridge`, `cross-chain`, `layer 2`, `l2`, `rollup`, `sequencer`, `restaking`, `hsm`, `key management`, `threshold signature`, `mev`, `intent`, `account abstraction`, `erc-4337`, `yield`, `liquidity`, `vault`, `nft`

**Stack vocabulary (17 terms):** `Rust`, `Solana`, `Ethereum`, `Python`, `Go`, `TypeScript`, `JavaScript`, `Move`, `Vyper`, `Solidity`, `Cairo`, `Haskell`, `Cosmos`, `Polkadot`, `NEAR`, `Avalanche`, `Polygon`

Matching is case-insensitive substring scan across the full aggregated markdown.

---

### Step 6 — ProfileComposer

**File:** `src/enrichment/EnrichmentEngine.ts` (`createProfileComposer`)

Assembles an `EnrichedProfile` (Zod-validated) from a `CompanyCandidate` + `WebsiteEnrichmentData | null`. Key decisions:

- **Company name:** Derived from `resolvedCompany.name` (hostname) if available; falls back to `authorHandle` with `@` stripped and first char capitalised for URL-less profiles.
- **Competency cell matching:** For each of 5 fingerprint cells, computes `score = matchedSignals.length / cell.primarySignals.length`. Used downstream to rank which cell's outreach template to apply.
- **`sources.websiteCrawl`:** Populated only when `websiteData !== null`. Contains `lastFetched` ISO timestamp, array of crawled URLs, and `fetcher: 'firecrawl'`.

Zod parse throws `ProfileComposerError` if the assembled object fails schema validation. `EnrichmentEngine.run()` catches `ProfileComposerError` and records the candidate in `failedCandidates` without aborting the batch.

---

### Step 7 — ReviewQueue (SQLite state machine)

**File:** `src/review-queue/ReviewQueue.ts`

**Table:**

```sql
CREATE TABLE IF NOT EXISTS queue_items (
  id              TEXT PRIMARY KEY,        -- profile.id (UUID v4)
  profile_json    TEXT NOT NULL,           -- JSON-serialised EnrichedProfile
  status          TEXT NOT NULL DEFAULT 'pending',
  enqueued_at     TEXT NOT NULL,           -- ISO 8601
  reviewed_at     TEXT,                    -- ISO 8601, set on review/drop
  annotation_json TEXT                     -- JSON-serialised ReviewAnnotation
);
```

**Valid transitions:**

```
pending      ──► reviewed     (enrich-pending: Tier A/B, signals present)
pending      ──► needs_retry  (enrich-pending: crawl failed + no signals — soft fail)
pending      ──► discarded    (enrich-pending: Tier C or no signals after successful crawl)
needs_retry  ──► reviewed     (enrich-pending re-run: crawl succeeds on retry)
needs_retry  ──► discarded    (enrich-pending re-run: crawl succeeds but still no signals)
needs_retry  ──► needs_retry  (enrich-pending re-run: crawl fails again)
reviewed     ──► drafted      (generate-outreach: LLM draft written)
reviewed     ──► discarded    (generate-outreach: second circuit breaker, no signals)
reviewed     ──► agent-running (AgentExecutionHarness: in progress)
drafted      ──► sent         (review-outreach HITL: approved)
drafted      ──► discarded    (review-outreach HITL: rejected)
pending      ──► dropped      (ReviewQueue.drop() — programmatic)
reviewed     ──► *            BLOCKED (AlreadyReviewedError thrown by ReviewQueue.submitReview)
```

**Soft-fail vs hard-fail routing (enrich-pending.ts):**

| Condition | Routing | Rationale |
|-----------|---------|-----------|
| Crawl error (network / timeout / 429) + no signals | `needs_retry` | Error is transient; lead may be valid |
| Crawl succeeded (or no URL) + no signals | `discarded` | No signals despite best effort; genuinely empty |
| Any crawl outcome + Tier C score | `discarded` | Logical hard fail; X-signal data itself scored low |

`annotation_json` for `needs_retry` items contains `{ "error": "Firecrawl failed — no signals extractable: <reason>" }` so `audit-discards.ts` can surface them for review.

`push()` uses `INSERT OR IGNORE` — pushing a profile with a duplicate UUID is a no-op, not an error.

**JSON column validation:**

All reads call `JSON.parse()` inline. All writes validate through Zod schemas before insert:
- `EnrichedProfileSchema.parse(profile)` in `push()`
- `ReviewAnnotationSchema.parse(annotation)` in `submitReview()`

Schema validation errors surface as Zod `ZodError` — they are not swallowed.

**`ReviewAnnotation` schema constraints:**

- `profileAdequate: false` requires `missingEvidenceTypes.length >= 1` (enforced via Zod `.refine()`)
- `profileAdequate: true` requires `missingEvidenceTypes` to be empty
- `profileId` must match the queue item `id` (enforced via `AnnotationMismatchError`)

---

## Fingerprint System

**Files:** `src/fingerprint/resolveFingerprint.ts`, `data/fingerprints/`

Each competency cell is a JSON file with `extends: ["core-web3-signals", "core-web3-anti-signals"]`. `resolveFingerprint()` loads and merges the three files at runtime, deduplicating signals by term (last-write wins). Cell-extends-cell is explicitly blocked — the resolver throws `FingerprintValidationError` if any extension target is not one of the two core files.

Core collision check: any term appearing in both `primarySignals` of core-web3-signals and `antiSignals` of core-web3-anti-signals (or vice versa) throws `FingerprintCollisionError` at load time.

**Five cells:**

| Cell | File | Sample primary terms |
|---|---|---|
| DeFi & Yield | `cells/defi-&-yield.json` | yield, amm, dex, tvl, flash loan, restaking |
| Trading | `cells/trading.json` | order book, market maker, liquidity provision |
| Infrastructure | `cells/infrastructure.json` | node, rpc, indexer, sequencer, rollup |
| Security | `cells/security.json` | audit, formal verification, hsm, key management |
| Payment Rails | `cells/payment-rails.json` | settlement, custody, remittance, payment |

---

## Database Schema Detail

**`EnrichedProfile` (Zod — `src/schema/enrichedProfile.ts`):**

```
id              uuid
enrichedAt      datetime
schemaVersion   "1.0.0"
sources
  xApi
    lastFetched         datetime
    tweetsConsidered    int
    founderHandle       string?
  websiteCrawl?
    lastFetched         datetime
    pagesCrawled        url[]
    fetcher             string          -- "firecrawl"
company
  name                  string (min 1)
  normalizedName        string
  websiteUrl            url?            -- absent for URL-less / lite profiles
  xHandle               string?
  linkedinUrl           url?
  country               string?
funding
  claimed
    amountUSD           number?
    stage               enum (pre_seed | seed | series_a | series_b | … | other)?
    claimedAt           datetime?
    rawText             string?
    templateMatched     string[]?
  confirmed?            -- populated by Crunchbase check in review step
product
  stackMentions         string[]
  architectureTerms     string[]
  antiSignalTerms       string[]
  competencyCellMatches { cell, matchedSignals, matchedCoreSignals, score }[]
  evidence              { page, snippet, relevance }[]
team
  founders              { name?, role?, xHandle?, linkedinUrl?, bioSnippet? }[]
  openRoles?            { title, stackHints, seniority? }[]
rawContent
  websiteMarkdown       Record<url, markdown>  -- keyed by crawled page URL
  sourceTweets?         { id, text, postedAt, authorHandle, authorBio? }[]
```

**`ReviewAnnotation`:**

```
profileId           uuid            -- must match queue_items.id
reviewedAt          datetime
reviewedBy          string
profileAdequate     boolean
missingEvidenceTypes  enum[]        -- required iff profileAdequate=false
tier                A | B | C
tierReason          string
downgradeReasons?   enum[]
reviewerNote?       string
crunchbaseCheck
  checked           boolean
  foundInCrunchbase boolean?
  actualAmountUSD   number?
  actualStage       FundingStage?
  actualDate        datetime?
```

---

## Resilience Mechanisms

### X API rate limiting

`ConcreteXApiClient` throws `XRateLimitError(retryAfterMs?)` on HTTP 429, parsing the `retry-after` response header. `EnrichmentEngine.run()` catches it and returns `{ status: 'rate_limited', retryAfterMs }`. The caller (CLI or scheduler) decides when to retry.

`XAuthError` (401/403) and `XNetworkError` (fetch rejection) propagate uncaught from `run()` — they indicate configuration or infrastructure failures that require human intervention.

### Firecrawl failures

`WebsiteEnrichmentError` (and its subtypes `PageFetchTimeoutError`, `PageFetchNetworkError`) are caught in `EnrichmentEngine.enrich()`. The profile is still composed using only X signal data (`websiteData = null`). The profile enters the queue as a lite profile.

In `enrich-pending.ts`, if the Firecrawl error leaves the profile with no technical signals, the item is routed to `needs_retry` (not `discarded`) — the crawl failure is treated as transient, not a judgment about lead quality. The error message is persisted in `annotation_json` for audit via `audit-discards.ts`.

Items in `needs_retry` are automatically re-selected by `enrich-pending.ts` (`WHERE status IN ('pending', 'needs_retry')`). On the next run, Firecrawl is attempted again. If it succeeds, the item graduates to `reviewed`; if it fails again, it remains `needs_retry`.

Any unexpected (non-`WebsiteEnrichmentError`) error propagates up and is caught by `run()`, recording the candidate in `failedCandidates`.

### ProfileComposer failures

`ProfileComposerError` (Zod validation failure on the assembled profile) is caught by `run()`. The candidate is added to `failedCandidates` and processing continues with the remaining batch.

### Idempotency

Three layers (see Step 3 above):
1. Candidate-level URL dedup in `run()` before any external call
2. In-memory `crawledUrls` Set inside `createEnrichmentEngine` for within-run dedup
3. `sources.websiteCrawl.lastFetched` pre-check in operational scripts for cross-run dedup

---

## Reliability Layer

Three mechanisms prevent low-signal data from propagating to the outreach stage.

### URL Normalizer

**File:** `src/cli/fetch-defillama.ts` (`resolveCanonicalUrl`)

Applied during DefiLlama ingestion. Each candidate URL is:

1. Scheme-normalised (prepends `https://` if missing)
2. Redirect-followed via `HEAD` with `redirect: 'follow'` and an 8-second `AbortSignal.timeout`
3. Tracking-param stripped (`utm_*`, `fbclid`, `gclid`, `mc_eid`, `ref`)
4. Validated: non-2xx responses, DNS failures, and timeouts return `null` — the protocol is logged as dead and skipped

Surviving URLs are checked against `existingUrls` (all `websiteUrl` values loaded from the queue at startup) before insert. A profile is never inserted if its resolved URL already exists in any queue status.

`405 Method Not Allowed` on HEAD is treated as live (server rejects HEAD but the site is reachable); the normalised input URL is used in place of the final redirect destination.

### F2 Anti-Vocab Filter

**File:** `src/enrichment/x-signal/filters.ts` (`detectAntiVocab`)

Applied during X API ingestion, before any Firecrawl call. Scans tweet text and author bio against two disqualifier vocabularies:

- **Core anti-signals** (`data/fingerprints/core-web3-anti-signals.json`): terms common to non-ICP entities — news aggregators, analytics firms, exchanges not building backend infrastructure
- **Cell anti-signals** (per competency cell JSON): terms that conflict with specific cell membership

A single match discards the candidate with label `f2:anti_vocab_match`. No Firecrawl credit is consumed for a filtered candidate.

### Circuit Breaker

**Files:** `src/cli/enrich-pending.ts` (`hasSubstantiveSignals`), `src/cli/generate-outreach.ts`

Applied at two points downstream of ingestion. The condition is the same at both points: `profile.product.stackMentions.length === 0 && profile.product.architectureTerms.length === 0`.

1. **Post-enrichment (Stage 2):** After the Firecrawl crawl completes (or fails), if no technical signals are present:
   - If the crawl **failed** (network/timeout error) → `needs_retry` (soft fail). The error message is stored in `annotation_json`. The item re-enters Stage 2 on the next `enrich-pending` run automatically.
   - If the crawl **succeeded or was skipped** → `discarded` (hard fail). No `ReviewAnnotation` is generated; no reviewed slot is consumed.
2. **Pre-LLM (Stage 3):** Before each Gemini API call, the check runs again. `reviewed` profiles with no signals are set to `discarded` without consuming an API credit.

The dual-stage circuit breaker prevents content-free prompts from reaching the LLM and ensures every Baron Sever email is grounded in verified technical signals extracted from the company's own website. The soft-fail path prevents false negatives from Firecrawl service interruptions.

---

## Technology Choices

| Choice | Rationale |
|---|---|
| `better-sqlite3` (sync) | No async overhead; WAL mode available when needed; no separate process |
| Zod at every boundary | Runtime type safety on untrusted external data (X API, Firecrawl JSON, SQLite reads) |
| `ts-jest` | No build step in tests; source maps for accurate stack traces |
| No DI framework | Three-argument factory functions (`createXSignalSource`, `createEnrichmentEngine`) are sufficient; DI frameworks add ceremony without benefit at this scale |
| No Redis | In-memory `Set` handles within-run dedup; SQLite handles cross-run state; Redis adds a process dependency |
