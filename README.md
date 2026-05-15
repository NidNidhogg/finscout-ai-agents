# FinScout Discovery Engine

Autonomous B2B lead discovery and enrichment pipeline for Web3/DeFi. Monitors the X (Twitter) firehose for funding announcements, scores candidates against competency-cell fingerprints, deep-crawls company websites via Firecrawl, and surfaces `EnrichedProfile` records for human review before outreach.

**Module A — complete and frozen. 386 tests, 0 errors.**

---

## System Overview

```
X API v2  ──►  5-stage filter chain  ──►  Company resolver
                                                │
                            ┌───────────────────┘
                            │  websiteUrl present?
                  No        │        Yes
            (lite profile)  │   FirecrawlFetcher
                            │   POST /v1/crawl (async)
                            │   GET  /v1/crawl/{id}  (poll)
                            │   Two-phase: doc/sdk paths first,
                            │   fallback to unrestricted crawl
                            │
                            ▼
                      Signal extraction (vocabulary scan)
                            │
                            ▼
                      ProfileComposer  ──►  EnrichedProfile (Zod)
                            │
                            ▼
                      ReviewQueue (SQLite)
                      pending → reviewed | dropped
                            │
                            ▼
                      CLI review tools  ──►  JSON export
```

---

## Prerequisites

| Dependency | Version | Purpose |
|---|---|---|
| Node.js | 20+ | Runtime |
| npm | 9+ | Package management |
| X API Bearer Token | Basic tier or above | Tweet search (`GET /2/tweets/search/recent`) |
| Firecrawl API key | Any paid tier | Async multi-page crawl |
| Anthropic API key | Phase 2 only | LLM email drafting (Module C) |

---

## Environment Variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `X_BEARER_TOKEN` | Yes | — | X API v2 Bearer Token |
| `FIRECRAWL_API_KEY` | Yes | — | Firecrawl REST key |
| `ANTHROPIC_API_KEY` | Phase 2 | — | Claude API key for outreach drafting |
| `X_SEARCH_QUERY` | No | See below | X search query string; avoid `has:links` |
| `REVIEW_DB_PATH` | No | `data/review-queue.db` | SQLite file path |
| `REVIEWER_ID` | No | `unknown` | Written to every `ReviewAnnotation` |
| `EXPORT_PATH` | No | `data/exports/reviewed-YYYY-MM-DD.json` | Output path for `review-export` |

**Default `X_SEARCH_QUERY`:**
```
(raised OR "seed round" OR "pre-seed" OR "series a" OR "in funding" OR "funding round")
(web3 OR defi OR crypto OR blockchain)
-is:retweet lang:en
```

Note: `has:links` is intentionally absent. URL-less tweets produce "lite" profiles (X data only, no Firecrawl call). This preserves signals from founders who don't include URLs in funding tweets.

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

### `run-enrichment.ts` — Full pipeline

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

### `inject-diamonds.ts` — Manual lead injection

Bypasses automated scoring. Inserts pre-qualified `EnrichedProfile` records directly with `status = reviewed` + a `ReviewAnnotation`. Deletes all existing `pending` items on completion. Use for known Tier A leads that don't need scoring.

```bash
npx ts-node src/cli/inject-diamonds.ts
```

No env vars required. Edit the `DIAMONDS` array in-file before running.

---

### `test-firecrawl-enrichment.ts` — Targeted crawl verification

Fetches all `reviewed` records, runs deep-crawl enrichment on those with a `websiteUrl` that have not yet been crawled (`sources.websiteCrawl` absent), prints per-page markdown previews and extracted signals, and writes updated `profile_json` back to SQLite.

```bash
npx ts-node src/cli/test-firecrawl-enrichment.ts
```

**Requires:** `FIRECRAWL_API_KEY`

**Idempotent:** profiles where `sources.websiteCrawl.lastFetched` is set are skipped with a log line — no Firecrawl credits consumed.

---

### `review-next.ts` — Interactive review

Dequeues the oldest `pending` item, renders its signals, and collects a structured `ReviewAnnotation` via interactive prompts: adequacy flag, missing evidence types, tier (A/B/C), tier reason, optional reviewer note, downgrade reasons, and Crunchbase verification.

```bash
REVIEWER_ID=you@example.com npx ts-node src/cli/review-next.ts
```

Must be run in an interactive terminal (uses `enquirer` prompts). `REVIEWER_ID` is written to every annotation — set it.

---

### `review-stats.ts` — Queue and DoD metrics

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

### `review-export.ts` — Export to JSON

Writes all `reviewed` items as a flat JSON array to `$EXPORT_PATH`. Fields: `id`, `company`, `websiteUrl`, `tier`, `profileAdequate`, `missingEvidenceTypes`, `tierReason`, `reviewerNote`, `enqueuedAt`, `reviewedAt`.

```bash
npx ts-node src/cli/review-export.ts
# → data/exports/reviewed-2026-05-15.json
```

This file is the input to Module C (Outreach Engine).

---

## Quality Gate

```bash
npm run lint   # 0 errors required
npm run test   # 386 / 386 required
npm run build  # tsc clean required
```

No test makes a live network call or writes to disk. All I/O is mocked at module boundaries via `jest.spyOn(global, 'fetch')` (HTTP) and `:memory:` SQLite databases.
