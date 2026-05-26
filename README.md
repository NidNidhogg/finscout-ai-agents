# FinScout — Autonomous Sales Factory

Autonomous four-stage sales pipeline for iDECP's Web3/DeFi outbound. Ingests live funding signals from X and on-chain protocol data, enriches company profiles via deep website crawl, generates precision cold outreach under the Baron Sever persona, and presents drafts for human approval via an interactive HITL CLI.

**v1.1 · Module A + Module C (Operational) · 386 tests · 0 errors**

---

## Golden Path

```bash
npm run scout
```

`scout` is the single-command MVA orchestrator. It chains five pipeline stages with `&&` — if any stage exits non-zero the chain halts immediately, preventing downstream API waste. On successful completion, an Excel export is generated automatically.

Equivalent to:

```bash
npx ts-node src/cli/fetch-funding.ts      # Stage 1 — X-Radar: ingest Web3/DeFi funding signals
npx ts-node src/cli/enrich-pending.ts     # Stage 2 — Firecrawl deep-crawl + ICP scoring
npx ts-node src/cli/generate-outreach.ts  # Stage 3 — Baron Sever outreach drafts via Gemini
npx ts-node src/cli/review-outreach.ts    # Stage 4 — HITL approval: Approve / Edit / Discard
npx ts-node src/cli/export-all-leads.ts   # Stage 5 — Excel export: exports/real_pipeline.xlsx
```

---

## Pipeline Overview

```
X API v2 ───────►  X-Radar filter chain  ────────────────────────────────────────┐
  fetch-funding      (first-person / VC bypass · $1M floor ·                      │
                      Web3/DeFi niche · Linktree unpack)                           │
                                                                                   │
DefiLlama API ──►  URL Normalizer  ──────────────────────────────────────────────┤
  fetch-defillama   (redirect follow · tracking-param strip · dead-URL discard)   │
                                                                                   │
                                                                                   ▼
                                                                         ReviewQueue (SQLite)
                                                                         status: pending
                                                                                   │
                                                                                   ▼
                                                                         Firecrawl deep-crawl
                                                                         (two-phase async)
                                                                                   │
                                                                     ┌─────────────┴──────────────┐
                                                                     │                            │
                                                              crawl error?                   crawl ok?
                                                            no signals yet              signals present?
                                                                     │                            │
                                                                     ▼                      ┌─────┴──────┐
                                                            ⏳ needs_retry              no signals    signals
                                                            (soft fail —             (hard discard) (scored)
                                                             re-runs next pass)            │            │
                                                                                           ▼            ▼
                                                                                       discarded    reviewed
                                                                                                        │
                                                                                                        ▼
                                                                                          Gemini 2.0 Flash
                                                                                          Baron Sever · 4-sentence
                                                                                                        │
                                                                                                        ▼
                                                                                             status: drafted
                                                                                                        │
                                                                                                        ▼
                                                                                          HITL review-outreach.ts
                                                                                          Approve / Edit / Discard
                                                                                                        │
                                                                                                        ▼
                                                                                             status: sent
```

---

## Required Environment Variables

| Variable | Stage | Notes |
|---|---|---|
| `GEMINI_API_KEY` | Stage 3 | Gemini 2.0 Flash — outreach draft generation |
| `FIRECRAWL_API_KEY` | Stage 2 | Firecrawl REST — async multi-page crawl |
| `X_BEARER_TOKEN` | X path only | X API v2 Bearer Token — `run-enrichment.ts` only |

Optional:

| Variable | Default | Notes |
|---|---|---|
| `REVIEW_DB_PATH` | `data/review-queue.db` | SQLite file path |
| `REVIEWER_ID` | `unknown` | Written to every `ReviewAnnotation` |
| `EXPORT_PATH` | `data/exports/reviewed-YYYY-MM-DD.json` | Output path for `review-export` |
| `X_SEARCH_QUERY` | See below | X ingestion query string |

**Default `X_SEARCH_QUERY`** (set in `fetch-funding.ts`):
```
("raised" OR "funding" OR "investing in")
("web3" OR "crypto" OR "defi" OR "stablecoin" OR "stablecoins" OR "yield" OR "blockchain" OR "protocol")
-is:retweet -is:reply lang:en
```

Stage/amount terms are deliberately absent from the query — extraction and threshold checks happen in the filter chain, not the API query. URL-less tweets produce lite profiles (X data only, no Firecrawl call).

---

## Prerequisites

| Dependency | Version | Purpose |
|---|---|---|
| Node.js | 20+ | Runtime |
| npm | 9+ | Package management |
| Gemini API key | Any tier | Stage 3 — outreach generation |
| Firecrawl API key | Any paid tier | Stage 2 — async website crawl |
| X API Bearer Token | Basic tier+ | X ingestion path only |

---

## Installation

```bash
npm install
npm run build   # compile → dist/
npm run test    # 386 tests
npm run lint    # eslint (0 errors)
```

---

## Env Loading

`.env` is loaded via `dotenv`. The `X_SEARCH_QUERY` variable contains spaces that break `export $(xargs)`. Use this invocation pattern for all CLI scripts:

```bash
node -e "require('dotenv').config(); \
  require('child_process').execSync('npx ts-node src/cli/<script>.ts', \
  { stdio: 'inherit', env: process.env })"
```

Or source variables explicitly before calling `npx ts-node`.

---

## CLI Commands

### Orchestrator — `npm run scout`

Runs the full five-stage pipeline sequentially. Each stage must exit 0 before the next starts. Stage 5 (Excel export) fires automatically on successful completion — no separate invocation required.

```bash
npm run scout
```

No flags. All configuration is via environment variables. If Stage 1 finds no new leads the chain still runs Stages 2–5 (which will be no-ops or produce an empty export if the queue is empty).

---

### Stage 1a — `fetch-funding.ts` — X-Radar ingestion

Polls X API v2 for Web3/DeFi funding announcements. Applies the filter chain: first-person/VC bypass gate → $1M funding floor → Linktree/aggregator URL unpacking → dedup by `normalizedName`. Inserts qualifying profiles as `pending`. Handles X API rate limits gracefully (logs retry delay, exits 0).

```bash
npx ts-node src/cli/fetch-funding.ts
```

**Requires:** `X_BEARER_TOKEN`

**Filter bypass rules:**
- **Brand bypass** — tweet contains a first-person funding phrase (`"we've raised"`, `"thrilled to announce"`, etc.)
- **VC bypass** — author handle/bio matches `TRUSTED_CRYPTO_VCS` allowlist (~70 entries) AND tweet contains `"investing in"`, OR tweet body contains `"led by"` / `"backed by"` a trusted VC

---

### Stage 1b — `fetch-defillama.ts` — DefiLlama ingestion

Fetches live protocol data from `api.llama.fi/protocols` (no API key required). Filters to ICP: TVL $10M–$100M, categories `Bridge | Dexes | Lending | Yield | Liquid Staking`. Resolves canonical URLs (follows redirects, strips tracking params, drops dead sites). Inserts up to 5 new profiles per run into the pending queue. Idempotent by resolved `websiteUrl`.

```bash
npx ts-node src/cli/fetch-defillama.ts
```

No env vars required beyond `REVIEW_DB_PATH` (optional).

```
[fetch-defillama] Fetching protocol list from api.llama.fi…
[fetch-defillama] 847 total protocols received.
[fetch-defillama] 12 candidates after ICP filter (TVL $10M–$100M, categories: Bridge, Dexes, …).

  Name                   URL                                    TVL        Category
  ──────────────────────────────────────────────────────────────────────────────────
  ✓ Velodrome            https://velodrome.finance              $45.2M     Dexes (@VelodromeFinance)
  ✗ DeadProtocol         https://dead-site.io                              dead/unreachable — skipped

[fetch-defillama] 1 protocol(s) inserted into pending queue → data/review-queue.db
```

---

### Stage 2 — `enrich-pending.ts` — Firecrawl enrichment pass

Selects all `pending` **and** `needs_retry` queue items. Runs Firecrawl two-phase deep-crawl on each with a `websiteUrl`. Merges extracted stack and architecture signals into `profile_json`. Applies a two-path circuit breaker:

| Condition | Status transition |
|-----------|------------------|
| Crawl failed (network/timeout) + no signals | `needs_retry` — soft fail, quarantined for next run |
| Crawl succeeded/skipped + no signals | `discarded` — hard fail, lead is genuinely empty |
| Scored Tier C (regardless of crawl outcome) | `discarded` — logical hard fail |
| Tier A or B with signals | `reviewed` — auto `ReviewAnnotation` generated |

`needs_retry` items re-enter the loop automatically on the next `enrich-pending` run. Idempotent: already-crawled profiles carry forward without a new Firecrawl call.

```bash
npx ts-node src/cli/enrich-pending.ts
```

**Requires:** `FIRECRAWL_API_KEY`

```
[enrich-pending] 3 pending item(s) to process.

  → Velodrome (@VelodromeFinance)      crawled 4 page(s)
    stack: Solidity, Python
    arch:  amm, dex, liquidity, vault
  → RheaLend (@rhea_finance)           crawl failed: PageFetchNetworkError
    ⏳ crawl failed + no signals → needs_retry
  → NoiseCo (abc12345)                 no websiteUrl — skipping crawl
    ⚡ no technical signals → discarded

[enrich-pending] Done.
  Crawled:        1
  Skipped crawl:  1
  Crawl errors:   1
  → reviewed:     1
  → needs_retry:  1 (soft fail: crawl error + no signals)
  → discarded:    1 (hard fail: no signals / Tier C)
```

---

### Stage 3 — `generate-outreach.ts` — Outreach draft generator

Reads all `reviewed` queue items. For each with extractable technical signals, generates a personalised cold email via Gemini 2.0 Flash under the Baron Sever persona. Uses a structured 4-sentence framework: **Hook** (specific signal acknowledgement) → **Hypothesis** (precise architectural challenge implied by signals) → **Value Drop** (iDECP angle) → **CTA** (one low-friction question). Writes all drafts to a single Markdown file. Promotes each record to `drafted`. Second circuit breaker: `reviewed` profiles with no signals are discarded without an LLM call.

```bash
npx ts-node src/cli/generate-outreach.ts
```

**Requires:** `GEMINI_API_KEY`

```
[generate-outreach] Found 2 reviewed profile(s). Drafting…

  → Velodrome (@VelodromeFinance)…  done
  → Contango (@contango_xyz)…       done

[generate-outreach] 2 draft(s) written → data/exports/outreach-drafts-2026-05-15-07-58-17.md
```

---

### Stage 4 — `review-outreach.ts` — HITL approval CLI

Presents every `drafted` item sorted Tier A → B → C, then by `enqueued_at` DESC (freshest leads first within each tier). For each item an interactive menu offers four actions:

| Action | Result |
|--------|--------|
| ✅ Approve & Send | `MockMailSender.send()` → status `sent` |
| ✏️ Edit Draft | Opens VS Code (`code --wait`), falls back to `nano`; persists edits to `agent_runs` |
| 🗑️ Reject / Discard | status `discarded` |
| ⏭️ Skip for Now | advances to next item, no status change |

Ctrl+C exits gracefully with a sent/discarded/skipped summary.

```bash
npx ts-node src/cli/review-outreach.ts
```

No env vars required beyond `REVIEW_DB_PATH` (optional).

---

### Stage 5 — `export-all-leads.ts` — Excel export

Queries the local SQLite database and writes a formatted Excel workbook to `exports/real_pipeline.xlsx`. Runs automatically as the final step of `npm run scout`, or on demand.

```bash
npm run export
```

No env vars required beyond `REVIEW_DB_PATH` (optional).

**Output:** `exports/real_pipeline.xlsx`

- All pipeline leads in a single sheet with column auto-filters enabled.
- Rows are tier colour-coded: Tier A (green), Tier B (yellow), Tier C (red/orange).
- Built with `exceljs` — no external spreadsheet service or API required.
- File is overwritten on each run; archive copies manually if a historical snapshot is needed.

---

### Supporting Commands

#### `run-enrichment.ts` — X API full pipeline

Polls X, runs the filter chain, crawls matched companies, assembles `EnrichedProfile` records, and pushes them into the pending queue.

```bash
npx ts-node src/cli/run-enrichment.ts
```

**Requires:** `X_BEARER_TOKEN`, `FIRECRAWL_API_KEY`

```
[run-enrichment] Polling X for: "(raised OR ...)"
[run-enrichment] Status: ok
[run-enrichment] Enriched: 4 profiles
[run-enrichment]   + Queued: PinAI (70aa4b07-...)
```

Possible status values: `ok` | `rate_limited` (prints retry delay from `retry-after` header).

---

#### `inject-diamonds.ts` — Manual lead injection

Bypasses automated scoring. Inserts pre-qualified `EnrichedProfile` records directly with `status = reviewed` + a `ReviewAnnotation`. Deletes all existing `pending` items on completion. Use for known Tier A leads that don't need scoring.

```bash
npx ts-node src/cli/inject-diamonds.ts
```

No env vars required. Edit the `DIAMONDS` array in-file before running.

---

#### `queue-dashboard.ts` — Pipeline status dashboard

Prints a live ASCII table of all queue items: company, website, tier, status (colour-coded), and enqueued timestamp. Active items appear first; `dropped`/`discarded` items are rendered in a dimmed section below.

```bash
npx ts-node src/cli/queue-dashboard.ts
```

---

#### `audit-discards.ts` — False-negative audit

Reads all `discarded` items, groups them by rejection-reason category (Firecrawl failure, timeout, no-signals, Tier C, etc.), and prints a summary bar chart plus the 5 most recently discarded items for spot-checking.

```bash
npm run audit-discards
```

Use this after a pipeline run to detect false negatives before they are permanently lost.

---

#### `inject-checker.ts` — Single-lead injection (demo/test)

Passes a specific tweet through the real filter chain, scores it as Tier A, and inserts it as `drafted` with a pre-written Baron Sever email in `agent_runs`. Used to validate the end-to-end path without a live X API call.

```bash
npx ts-node src/cli/inject-checker.ts
```

---

#### `test-firecrawl-enrichment.ts` — Targeted crawl verification

Fetches all `reviewed` records, runs deep-crawl enrichment on those with a `websiteUrl` that have not yet been crawled (`sources.websiteCrawl` absent), prints per-page markdown previews and extracted signals, and writes updated `profile_json` back to SQLite.

```bash
npx ts-node src/cli/test-firecrawl-enrichment.ts
```

**Requires:** `FIRECRAWL_API_KEY`

**Idempotent:** profiles where `sources.websiteCrawl.lastFetched` is set are skipped with a log line — no Firecrawl credits consumed.

---

#### `review-next.ts` — Interactive review

Dequeues the oldest `pending` item, renders its signals, and collects a structured `ReviewAnnotation` via interactive prompts: adequacy flag, missing evidence types, tier (A/B/C), tier reason, optional reviewer note, downgrade reasons, and Crunchbase verification.

```bash
REVIEWER_ID=you@example.com npx ts-node src/cli/review-next.ts
```

Must be run in an interactive terminal (uses `enquirer` prompts). `REVIEWER_ID` is written to every annotation — set it.

---

#### `review-stats.ts` — Queue and DoD metrics

```bash
npx ts-node src/cli/review-stats.ts
```

```
═══════════════════════════════════════════════
  REVIEW QUEUE STATS
═══════════════════════════════════════════════
  Pending:  12   Reviewed: 18   Dropped: 2
───────────────────────────────────────────────
  Total reviewed:     18
  Adequacy rate:      83.3% ✓  (target ≥80%)
  Volume threshold:   ✗  (18/25)
  DoD met:            NO ✗
───────────────────────────────────────────────
  TIER DISTRIBUTION
  A: 8  B: 7  C: 3
═══════════════════════════════════════════════
```

**DoD is met** when all three conditions hold simultaneously:
1. ≥ 25 profiles reviewed
2. Adequacy rate ≥ 80%
3. No single failure mode accounts for > 40% of inadequate cases

---

#### `review-export.ts` — Export to JSON

Writes all `reviewed` items as a flat JSON array to `$EXPORT_PATH`. Fields: `id`, `company`, `websiteUrl`, `tier`, `profileAdequate`, `missingEvidenceTypes`, `tierReason`, `reviewerNote`, `enqueuedAt`, `reviewedAt`.

```bash
npx ts-node src/cli/review-export.ts
# → data/exports/reviewed-2026-05-15.json
```

---

## Quality Gate

```bash
npm run lint   # 0 errors required
npm run test   # 386 / 386 required
npm run build  # tsc clean required
```

No test makes a live network call or writes to disk. All I/O is mocked at module boundaries via `jest.spyOn(global, 'fetch')` (HTTP) and `:memory:` SQLite databases.
