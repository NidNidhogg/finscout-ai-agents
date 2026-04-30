# FinScout Discovery Engine — Module A

> **Phase:** 1.0 — Complete  
> **Classification:** Internal — Engineering  
> **Domain:** Autonomous Web3 Lead Discovery & Enrichment

Module A is a fully automated pipeline that polls X (Twitter) for real-time funding announcements from Web3 companies, enriches each match with website content via Firecrawl, assembles a structured `EnrichedProfile`, and queues it for human review. The review queue feeds a Definition-of-Done gate before leads graduate to outreach.

---

## Architecture Overview

```
X API v2 (Basic)
     │
     ▼
ConcreteXApiClient ─── Tweet[]
     │
     ▼
XSignalSource  ◄── ResolvedFingerprint[] (5 cells)
 ├─ Filter 1: matchesTemplates()        (funding announcement)
 ├─ Filter 2: detectAntiVocab()         (retail / outsourcing exclusion)
 ├─ Filter 3: matchPrimarySignals()     (density threshold)
 └─ Filter 4: ConcreteCompanyResolver() (URL extraction from tweet)
     │
     ▼
 CompanyCandidate[]
     │
     ▼
EnrichmentEngine (orchestrator)
 ├─ Deduplicates by websiteUrl
 ├─ FirecrawlFetcher ──► WebsiteEnricher ──► WebsiteEnrichmentData
 └─ ProfileComposer ────────────────────────► EnrichedProfile
     │
     ▼
ReviewQueue (SQLite)
     │
     ▼
CLI Review Tools ──► Definition-of-Done Gate (≥25 reviewed, ≥80% adequate)
```

### Core Components

| Component | File | Role |
|-----------|------|------|
| `ConcreteXApiClient` | `src/enrichment/x-signal/ConcreteXApiClient.ts` | X API v2 `GET /2/tweets/search/recent` with Bearer token |
| `ConcreteCompanyResolver` | `src/enrichment/x-signal/ConcreteCompanyResolver.ts` | URL extraction from tweet text; derives company name from hostname |
| `FirecrawlFetcher` | `src/enrichment/website/FirecrawlFetcher.ts` | Firecrawl REST `POST /v1/scrape`; maps to `FetchedPage` |
| `XSignalSource` | `src/enrichment/x-signal/XSignalSource.ts` | 4-stage filter pipeline; emits `CompanyCandidate[]` |
| `EnrichmentEngine` | `src/enrichment/EnrichmentEngine.ts` | Orchestrates poll → crawl → compose; owns rate-limit and dedup logic |
| `ReviewQueue` | `src/review-queue/ReviewQueue.ts` | SQLite-backed queue with DoD metrics |

### Fingerprint Data

Competency vocabulary lives in `data/fingerprints/`:

```
data/fingerprints/
├── core-web3-signals.json        # Universal Web3 B2B quality markers
├── core-web3-anti-signals.json   # Retail / outsourcing exclusion terms
└── cells/
    ├── defi-&-yield.json
    ├── trading.json
    ├── infrastructure.json
    ├── security.json
    └── payment-rails.json
```

Each cell fingerprint extends both core files. `resolveFingerprint()` merges core + cell signals at runtime.

---

## Prerequisites

- **Node.js** 20 or later
- **npm** 9 or later
- **X API Basic tier** Bearer Token (required for `run-enrichment`)
- **Firecrawl API key** (required for `run-enrichment`)

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

Create a `.env` file in the project root (or export variables in your shell):

```dotenv
# Required for run-enrichment
X_BEARER_TOKEN=your_x_api_bearer_token_here
FIRECRAWL_API_KEY=your_firecrawl_api_key_here

# Optional — defaults shown
X_SEARCH_QUERY="seed round defi web3 crypto"
REVIEW_DB_PATH=data/review-queue.db

# Used by review-next
REVIEWER_ID=analyst@example.com

# Used by review-export
EXPORT_PATH=data/exports/reviewed-2026-04-30.json
```

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `X_BEARER_TOKEN` | Yes | — | X API v2 Basic tier Bearer Token |
| `FIRECRAWL_API_KEY` | Yes | — | Firecrawl REST API key |
| `X_SEARCH_QUERY` | No | `seed round defi web3 crypto` | X API search query (broad pre-filter) |
| `REVIEW_DB_PATH` | No | `data/review-queue.db` | Path to the SQLite review queue database |
| `REVIEWER_ID` | No | `unknown` | Identifier recorded on each review annotation |
| `EXPORT_PATH` | No | `data/exports/reviewed-<date>.json` | Output path for `review-export` |

---

## CLI Usage

All CLI scripts are run with `ts-node` from the project root.

### `run-enrichment` — Run the discovery pipeline

Polls X, filters candidates, enriches profiles via Firecrawl, and pushes results to the review queue.

```bash
npx ts-node src/cli/run-enrichment.ts
```

Output example:
```
[run-enrichment] Polling X for: "seed round defi web3 crypto"
[run-enrichment] Status: ok
[run-enrichment] Enriched: 3 profiles
[run-enrichment] Failed:   0 candidates
[run-enrichment]   + Queued: AcmeDeFi (f47ac10b-...)
[run-enrichment]   + Queued: StableProtocol (...)
```

### `review-next` — Interactive profile review

Displays the next pending profile and prompts for adequacy, tier, missing evidence, and Crunchbase check.

```bash
npx ts-node src/cli/review-next.ts
```

The reviewer is guided through:
1. Is this profile adequate? (y/n)
2. Missing evidence types (multiselect, only if inadequate)
3. Tier assignment: A / B / C
4. Tier reason (free text)
5. Optional reviewer note
6. Downgrade reasons (multiselect, only for B/C)
7. Crunchbase check

### `review-stats` — Print queue and DoD metrics

```bash
npx ts-node src/cli/review-stats.ts
```

Output example:
```
═══════════════════════════════════════════════
  REVIEW QUEUE STATS
═══════════════════════════════════════════════
  Pending:  12
  Reviewed: 18
  Dropped:  2
───────────────────────────────────────────────
  DEFINITION OF DONE
───────────────────────────────────────────────
  Total reviewed:     18
  Adequacy rate:      83.3% ✓ (target ≥80%)
  Volume threshold:   ✗ (18/25)
  DoD met:            NO ✗
───────────────────────────────────────────────
  TIER DISTRIBUTION
───────────────────────────────────────────────
  A: 8  B: 7  C: 3
═══════════════════════════════════════════════
```

**DoD is met** when all three conditions are true simultaneously:
- ≥ 25 profiles reviewed
- Adequacy rate ≥ 80%
- No single failure mode exceeds 40% of inadequate cases

### `review-export` — Export reviewed records to JSON

```bash
npx ts-node src/cli/review-export.ts
```

Writes a JSON array of reviewed records to `$EXPORT_PATH` (default: `data/exports/reviewed-<date>.json`). Each record contains company name, URL, tier, adequacy, missing evidence types, and tier reason.

---

## Testing

### Run all tests

```bash
npm test
```

### Run with coverage

```bash
npm run test -- --coverage
```

### Run a single test file

```bash
npx jest src/enrichment/x-signal/XSignalSource.test.ts
```

### Run a single test by name

```bash
npx jest -t "AC-006"
```

### Full quality gate (lint → test → build)

```bash
bash scripts/quality-gate.sh
```

Current status: **323 tests passing across 20 test suites, 0 errors.**

### Test architecture

Tests use Jest with `ts-jest`. All external I/O is mocked at module boundaries:

- **X API calls** — `jest.spyOn(global, 'fetch')` in `ConcreteXApiClient.test.ts`
- **Firecrawl calls** — `jest.spyOn(global, 'fetch')` in `FirecrawlFetcher.test.ts`
- **SQLite** — in-memory `better-sqlite3` instance (`new Database(':memory:')`)
- **Fingerprints** — injected `ResolvedFingerprint[]` stubs

No test makes a real network call. No test writes to disk.

---

## Project Structure

```
src/
├── cli/                        # Wave 6: CLI entry points
│   ├── run-enrichment.ts       # Main pipeline wiring
│   ├── review-next.ts          # Interactive reviewer
│   ├── review-stats.ts         # DoD metrics display
│   └── review-export.ts        # JSON export
├── enrichment/                 # Wave 3–5: Enrichment pipeline
│   ├── EnrichmentEngine.ts     # Orchestrator + WebsiteEnricher + ProfileComposer
│   ├── x-signal/
│   │   ├── XSignalSource.ts    # 4-stage filter + interfaces + error classes
│   │   ├── filters.ts          # matchesTemplates / detectAntiVocab / matchPrimarySignals
│   │   ├── ConcreteXApiClient.ts
│   │   └── ConcreteCompanyResolver.ts
│   ├── website/
│   │   └── FirecrawlFetcher.ts
│   └── sources/
│       └── FixturePageFetcher.ts  # Test-only; reads from data/fixtures/pages/
├── fingerprint/                # Wave 2: Fingerprint resolver
│   ├── resolveFingerprint.ts
│   └── schemas.ts
├── review-queue/               # Wave 2: SQLite review queue
│   ├── ReviewQueue.ts
│   ├── DoDMetrics.ts
│   └── types.ts
└── schema/
    └── enrichedProfile.ts      # Zod schemas: EnrichedProfile, ReviewAnnotation
data/
├── fingerprints/               # Wave 6: Competency vocabulary JSON files
└── fixtures/                   # Test fixtures for FixturePageFetcher
specs/                          # iDECP specification documents
```

---

## Definition of Done

The pipeline is considered production-ready for Phase 1 outreach when:

1. ≥ 25 profiles have been manually reviewed (`review-stats` shows `Volume threshold: ✓`)
2. ≥ 80% of reviewed profiles are rated adequate (`Adequacy rate ≥ 80%`)
3. No single failure mode (e.g., `noise_false_positive`) accounts for > 40% of inadequate cases

Run `bash scripts/quality-gate.sh` before any deployment to confirm the code gate is clear.
