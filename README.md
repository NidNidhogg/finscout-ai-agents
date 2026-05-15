# FinScout — Autonomous Sales Factory

Autonomous three-stage sales pipeline for iDECP's Web3/DeFi outbound. Ingests live on-chain protocol data, enriches company profiles via deep website crawl, and generates precision cold outreach under the Baron Sever persona.

**v1.0 · Module A + Module C (Soft Launch) · 386 tests · 0 errors**

---

## Golden Path

```bash
npx ts-node src/cli/fetch-defillama.ts    # Stage 1 — Ingest ICP protocols from DefiLlama
npx ts-node src/cli/enrich-pending.ts     # Stage 2 — Deep-crawl + signal extraction
npx ts-node src/cli/generate-outreach.ts  # Stage 3 — Generate Baron Sever outreach drafts
```

Output: `data/exports/outreach-drafts-YYYY-MM-DD-HH-MM-SS.md` — human-in-the-loop. Review, edit, send manually.

---

## Pipeline Overview

```
DefiLlama API ──►  URL Normalizer  ──────────────────────────────────────────────┐
                   (redirect follow,                                               │
                    tracking-param strip,                                          │
                    dead-URL discard)                                              │
                                                                                  │
X API v2 ──────►   5-stage filter chain  ────────────────────────────────────────┤
                   (F1 template · F2 anti-vocab · F3 density ·                    │
                    F5 funding floor · F4 company resolver)                        │
                                                                                  │
                                                                                  ▼
                                                                        ReviewQueue (SQLite)
                                                                        status: pending
                                                                                  │
                                                                                  ▼
                                                                        Firecrawl deep-crawl
                                                                        (two-phase async)
                                                                                  │
                                                                                  ▼
                                                                      ⚡ Circuit Breaker
                                                                        (no signals → discard)
                                                                                  │
                                                                                  ▼
                                                                        status: reviewed
                                                                                  │
                                                                                  ▼
                                                                        Gemini 2.0 Flash
                                                                        Baron Sever · 4-sentence
                                                                                  │
                                                                                  ▼
                                                                data/exports/outreach-drafts-*.md
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

**Default `X_SEARCH_QUERY`:**
```
(raised OR "seed round" OR "pre-seed" OR "series a" OR "in funding" OR "funding round")
(web3 OR defi OR crypto OR blockchain)
-is:retweet lang:en
```

`has:links` is intentionally absent. URL-less tweets produce lite profiles (X data only, no Firecrawl call).

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

### Stage 1 — `fetch-defillama.ts` — DefiLlama ingestion

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

Selects all `pending` queue items. Runs Firecrawl two-phase deep-crawl on each with a `websiteUrl`. Merges extracted stack and architecture signals into `profile_json`. Applies circuit breaker: profiles where both `stackMentions` and `architectureTerms` are empty after crawl are set to `discarded`. Remaining profiles receive an auto-generated `ReviewAnnotation` (tier B/C) and are promoted to `reviewed`. Idempotent: already-crawled profiles carry forward without a new Firecrawl call.

```bash
npx ts-node src/cli/enrich-pending.ts
```

**Requires:** `FIRECRAWL_API_KEY`

```
[enrich-pending] 3 pending item(s) to process.

  → Velodrome (@VelodromeFinance)      crawled 4 page(s)
    stack: Solidity, Python
    arch:  amm, dex, liquidity, vault
  → SomeProtocol (abc12345)            crawl failed: PageFetchNetworkError
    ⚡ no technical signals → discarded

[enrich-pending] Done.
  Crawled:       2
  Skipped crawl: 0
  Crawl errors:  1
  → reviewed:    2
  → discarded:   1 (circuit breaker: no technical signals)
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
