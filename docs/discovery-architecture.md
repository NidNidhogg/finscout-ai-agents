# Discovery Architecture

> **Classification:** Internal — Engineering
> **Status:** Pre-spec architecture document (v0.1)
> **Scope:** The FinScout lead-discovery pipeline — from public signal to human-reviewed outreach candidate
> **Audience:** Anyone implementing or reviewing specs for `competency-matrix/`, `website-qualifier/`, `x-funding-listener/`, or `review-queue/`

This document captures the architectural decisions that shape the FinScout discovery pipeline. It is the parent document for the four module specs that follow. Its purpose is to pin down *interfaces, contracts, and constraints* so that spec authors and implementers do not re-litigate structural questions during TDD.

Where decisions were made with incomplete information, assumptions are marked **[ASSUMPTION]** and must be confirmed or corrected during review.

---

## 1. Thesis

FinScout sells [MVA (Minimum Viable Architecture)](../RT_prezentation_v_7_1__long_.pdf) engineering services to early-stage fintech and Web3 startups. The Sales Factory's job is to find companies that are (a) at a stage where MVA work fits (pre-scale, pre-rewrite), and (b) building a product whose architecture maps to RadianceTeam's competency matrix.

The **central thesis** of this architecture is:

> **X is the only programmatically-accessible discovery channel that produces fresh signal before competitors act on it.** Crunchbase is authoritative but lags and is not legitimately scrapable. LinkedIn is rich but scrape-hostile for discovery. Company websites are the authoritative qualification source but are found, not discovered. X is where founders announce their rounds *before* those rounds show up in any structured database — and every week of lead time preserved at the discovery layer is a week preserved in the 6-12-week MVA foundation-decision window.

The pipeline is designed around this asymmetry: **X for discovery, websites for qualification, human judgment for tier assignment, Crunchbase (manual) for verification.**

---

## 2. Constraints That Shaped the Design

These constraints are the result of explicit conversations and business realities. Any future change to the architecture should start by re-examining whether these constraints still hold.

- **ToS-legitimate data access only.** X has a real API; we use it. Crunchbase and LinkedIn are both scrape-hostile at the API level. We do not scrape them for discovery. Crunchbase appears in the pipeline only as a human-reviewed verification step. LinkedIn is reserved entirely for outreach (a separate concern, not this pipeline).
- **Target throughput: 25 reviewable candidates per week.** This pins the whole funnel shape (see §5).
- **65-company labeled dataset** (38 Tier A, 14 Tier B, 14 Tier C) available as ground truth for validating the website qualifier.
- **English-only pipeline** end to end — data, schemas, prompts, review queue, logs. The English version of the ICP sheet is canonical.
- **Competency matrix (5 cells)** from the RadianceTeam sales deck is the authoritative ICP reference — not sector codes, not Crunchbase taxonomy. See §3.
- **Foundation-window business model.** Target companies are $2M–$35M funded, Pre-Seed through Series A, within ~6-12 weeks of their foundation-architecture decisions.
- **Deployment model:** Docker Compose, matching the pattern in the FinScout README (`docker compose up -d finscout-discovery-engine`). **[ASSUMPTION — confirm in review]**
- **Budget ceiling for external services: ~$150/month.** Covers Firecrawl, X API, and Claude extraction calls at expected throughput. **[ASSUMPTION — confirm in review]**
- **Existing FinScout codebase:** Node 20, TypeScript 5.x, Jest 30, Zod v4, Express. The pipeline lives inside this codebase, not as a separate service.
- **Protocol compliance:** All new modules follow the iDECP protocol — spec first, test scaffold, red-green TDD, Zod-validated interfaces, pure logic separated from I/O.

---

## 3. The Competency Matrix as Spine

The competency matrix is the single authoritative definition of what FinScout's ICP actually is. It comes from the RadianceTeam deck (slide 11) and consists of five cells:

| Cell | Description | Keyword Markers (representative) | Example Tier A Matches |
|------|-------------|----------------------------------|------------------------|
| **DeFi & Yield** | Stablecoins (TRON, ETH, TON), Rebase mechanisms, Staking logic | stablecoin, rebase, yield, staking, TRON, TON, EVM | Avenia, Bleap, Levl, YO Labs, LumeFi |
| **Trading** | Margin trading engines, Risk management blocks, DEX/AMM forks | margin, liquidation, AMM, DEX, order book, MEV, risk engine | Architect, Penguin Sec., RateX, fomo, Hello Trade |
| **Infrastructure** | Cross-chain bridges, Multisig governance, High-load microservices | cross-chain, bridge, multisig, throughput, latency, microservice | Rift, Euclid, Sprinter, Superset, Firefish, Bitway |
| **Security** | Audited smart contracts, HSM software modules, Cryptography, Decentralized ID | HSM, audit, formal verification, multisig, GOST, KMS, DID | CheckSig, Deblock, Axiology, Tenbin Labs, OpenEden |
| **Payment Rails** | SBP integration, Fiat-to-Crypto gateways | Fiat-to-Crypto, gateway, settlement, on-ramp, off-ramp, AML | Ruvo, PEXX, Nodu, Based, Netaro |

Every candidate in the pipeline is scored against **each cell independently** on a 0.0–1.0 relevance scale. A company may match multiple cells; multi-cell matches are *stronger signals* (indicating broader architectural need) and should rank higher in the review queue.

The matrix is **the spine** in the sense that every downstream decision references it:
- Stage 1's X vocabulary filter is derived from cell keyword markers.
- Stage 2's website qualifier scores each candidate per cell.
- The review queue's prioritization uses aggregate cell scores.
- The tiering rubric references which and how many cells matched.

### 3.1 Relationship to the Cluster 1/2/3 Taxonomy

The ICP spreadsheet uses Cluster 1 (Stablecoins & Custody), Cluster 2 (RWA & Tokenization), Cluster 3 (Trading/DEX/Yield) as groupings.

**[ASSUMPTION — confirm in review]** These clusters are *market-facing product categories* — how the market and Crunchbase describe these companies. They are **orthogonal** to the competency matrix, which captures *RadianceTeam's supply-side capabilities*. A single company has both attributes:

- `productCluster` (market-side): derived from Crunchbase sector and the company's own product description.
- `competencyScores` (supply-side): computed by the pipeline against the 5 cells.

Clusters are used for **reporting and human navigation** (e.g., "show me this week's Tier A candidates in Cluster 1"). Scoring and prioritization run on the competency matrix.

### 3.2 Reference Clients as Fingerprint Seeds

**[ASSUMPTION — confirm in review]** RadianceTeam's existing customer case studies (the stablecoin management system operating at billion-dollar volumes per the deck, and any others) are treated as a parallel dataset alongside the 65-company Crunchbase ICP:

```
ICPReference = {
  crunchbaseICP: ICPMember[],      // The 65 from your current list
  referenceClients: ICPMember[],   // Existing RadianceTeam customers
}
```

Both feed the competency fingerprint. Reference clients are **weighted higher** (e.g., 2×) in fingerprint derivation because they are ground-truth positive examples of successful MVA engagements, not just hypothesized fits.

---

## 4. Pipeline Overview

```
                   ICPReference
                  (matrix + dataset)
                         │
                         ▼
              ┌──────────────────────┐
              │ Competency Fingerprint│
              │  (5 cell vocabularies) │
              └──────────┬───────────┘
                         │
         ┌───────────────┼───────────────┐
         │               │               │
         ▼               ▼               ▼
┌────────────────┐ ┌────────────┐ ┌─────────────┐
│ Stage 1:       │ │ Stage 2:   │ │ Stage 3:    │
│ X Funding-     │ │ Website    │ │ Human       │
│ Listener       │─▶ Qualifier  │─▶ Review      │
│                │ │            │ │ Queue       │
└────────────────┘ └────────────┘ └──────┬──────┘
                                         │
                                         ▼
                                   sales-factory.
                                   qualifyLead()
                                         │
                                         ▼
                                   Outreach Queue
                                  (LinkedIn, manual
                                   or via future
                                   connector)
```

- **Stage 1 — X Funding-Listener:** surfaces ~50-65 funding-matched candidates per week from X, filtered by competency vocabulary.
- **Stage 2 — Website Qualifier:** crawls each candidate's website via Firecrawl, scores against the competency matrix, detects hard-gate signals. Outputs ~25 qualified candidates per week.
- **Stage 3 — Human Review Queue:** prioritized by Stage 2 score, surfaced to a human reviewer who confirms funding/stage/team size via Crunchbase UI and assigns Tier A/B/C. Outputs ~18-20 Tier A/B per week to outreach.

Each stage is independently specified, tested, and swappable. The pipeline contracts between stages are typed `Zod` schemas (see §6).

---

## 5. Throughput Targets and Implications

Working backwards from the 25-per-week review target:

| Stage | Input | Output | Pass Rate | Weekly Output |
|-------|-------|--------|-----------|---------------|
| Stage 1 (X) | X firehose (competency-filtered) | FundingSignal | N/A (filter) | ~60/wk |
| Stage 2 (Website) | FundingSignal | QualifiedCandidate | ~40-60% | ~25/wk |
| Stage 3 (Review) | QualifiedCandidate | TieredLead (A/B) | ~70-80% A/B | ~18-20/wk |

### 5.1 Precision Requirements

For the review queue to be worth a human reviewer's time, **≥70% of reviewed candidates should be plausibly Tier A or Tier B**. Below that threshold, the queue feels like noise and will be skipped. Above ~90%, the qualifier is too strict and likely missing real leads.

### 5.2 Review Capacity

25 candidates/week × 3 minutes/candidate ≈ 75 minutes/week of human review. Sustainable load for a founder or a half-time reviewer.

### 5.3 Outreach Capacity Tension

**[FLAG]** 18-20 Tier A/B per week going into outreach will likely exceed current outreach throughput (based on the pace visible in the ICP sheet's Status column). Once the pipeline is running, expect to either:

- **Tighten Stage 2** to produce fewer but higher-confidence candidates matching outreach capacity, OR
- **Scale outreach** — which is the logical next system buildout (see `docs/linkedin-connector.md`, not yet written).

This is a downstream concern but worth anticipating. The Stage 2 threshold is a tunable dial; do not hardcode its value.

---

## 6. Stage Contracts (Interfaces)

These are the typed interfaces between stages. Full Zod schemas belong in each stage's spec, but the shapes are pinned here so specs align.

### 6.1 `FundingSignal` — Stage 1 → Stage 2

```typescript
FundingSignal = {
  id: string;                          // uuid
  discoveredAt: Date;                  // when Stage 1 surfaced it
  source: "x";                         // future: "x" | "crunchbase" | ...

  // Claimed funding from the tweet
  claimedAmount: {
    valueUSD: number;                  // parsed from tweet; may be approximate
    stage?: FundingStage;              // Pre-Seed, Seed, Series A, etc.
    claimedAt: Date;                   // date of the announcement tweet
    confidence: number;                // 0.0-1.0 from template match strength
  };

  // Identity resolution
  company: {
    nameAsStated: string;              // from the tweet
    handleX?: string;                  // @handle if findable
    websiteUrl?: URL;                  // derived from X bio or tweet link
  };
  founder?: {
    nameAsStated?: string;
    handleX: string;                   // the founder who announced
  };

  // Why we surfaced it
  evidence: {
    tweetUrl: URL;
    tweetText: string;
    matchedTemplates: string[];        // which funding-announcement patterns fired
    suspectedCells: CompetencyCell[];  // which matrix cells the vocabulary touched
  };

  // Dedup key (so we don't enqueue the same company twice within N days)
  dedupKey: string;                    // normalized company name + claimedAmount
};
```

### 6.2 `QualifiedCandidate` — Stage 2 → Stage 3

```typescript
QualifiedCandidate = {
  id: string;
  fundingSignal: FundingSignal;       // carries the Stage 1 evidence through

  // Website crawl results
  websiteQualification: {
    crawledAt: Date;
    pagesVisited: URL[];               // e.g., /about, /careers, /docs
    fetcherImpl: "firecrawl" | string; // for audit / future swap

    // Per-cell competency scoring
    competencyScores: Record<CompetencyCell, {
      score: number;                   // 0.0-1.0
      evidence: string[];              // quoted snippets supporting the score
      extractionMethod: "deterministic" | "llm" | "hybrid";
    }>;

    // Hard-gate signals observed
    hardGateSignals: {
      teamSizeEstimate?: number;       // from /about, /careers
      stageSignals: string[];          // e.g., "seed round announced", "hiring first 5"
      architectureEvidence: string[];  // specific tech mentioned
      antiSignals: string[];           // e.g., "looking for cheap dev shop"
    };

    // Overall score used for review queue priority
    aggregateScore: number;            // composite for ranking
  };
};
```

### 6.3 `TieredLead` — Stage 3 → `sales-factory`

```typescript
TieredLead = {
  id: string;
  qualifiedCandidate: QualifiedCandidate;

  review: {
    reviewedAt: Date;
    reviewedBy: string;                // for audit
    tier: "A" | "B" | "C";
    tierReason: string;                // required free-text justification
    crunchbaseConfirmed: {
      // Filled in during manual Crunchbase check
      foundInCrunchbase: boolean;
      actualAmountUSD?: number;
      actualStage?: FundingStage;
      actualDate?: Date;
      leadTimeDays?: number;           // X-claimed date → Crunchbase-indexed date
    };
    downgradeReasons?: string[];       // if B or C: why
  };
};
```

The `TieredLead` feeds directly into `sales-factory.qualifyLead()` (existing iDECP module) for downstream scoring against the hard gates (+40/+30/+30/−50) and mapping into the MVA block via the Researcher Agent.

---

## 7. Stage 1: X Funding-Listener

### 7.1 Responsibility

Monitor X for funding-announcement posts that match the competency vocabulary, producing `FundingSignal` records. This is a recency-biased, narrow-pattern listener — not a general X scraper.

### 7.2 Core Computation

1. **Subscription to a filtered X stream** (via X API v2 filtered stream or recent-search on a cadence).
2. **Template matching** against funding-announcement phrase patterns. Representative templates (non-exhaustive):
   - `"(we|[Company]) (raised|closed|secured|announced).*\$[0-9]+M"`
   - `"excited to (share|announce).*(seed|series A|pre-seed)"`
   - `"today.*closed.*(funding|round)"`
   - Emoji + dollar-amount patterns (e.g., "🎉 $7M")
3. **Competency vocabulary filter** — the post (or the author's bio + recent tweets) must contain vocabulary from at least one competency cell above a minimum density threshold.
4. **Company resolution** — extract company name, resolve X handle and website URL (prefer handle bio link; fall back to Google Knowledge Graph-style lookup or Claude-assisted disambiguation if needed).
5. **Deduplication** against the ICPReference dataset (already-known companies) and against the recent FundingSignal log (don't re-enqueue the same tweet or the same company/round twice).
6. **Emission** of a `FundingSignal` into Stage 2's queue.

### 7.3 Implementation Notes

- **Two-layer matcher:** deterministic templates catch the high-precision majority; an optional Claude-based secondary classifier handles the long tail of non-template funding announcements. The LLM layer runs *only* on posts that contain competency vocabulary but did not match any template — bounded cost.
- **Language:** English-only filter. Non-English tweets are rejected at the source.
- **Rate limits:** X API access is rate-limited; the listener must respect quotas. Use cached recent-search rather than filtered streaming if stream cost is prohibitive.
- **[ASSUMPTION — confirm in review]** X API tier: **"Basic" ($100/month)** is the target tier. Free tier is too restrictive; Pro tier is over-scoped. Basic gives ~10K tweets/month retrieval, sufficient for a vocabulary-filtered niche listener.

### 7.4 Spec Location

`specs/x-funding-listener/spec.md`. Expected AC count: ~20-25.

---

## 8. Stage 2: Website Qualifier

### 8.1 Responsibility

For each `FundingSignal`, fetch and analyze the company's website to produce a `QualifiedCandidate` with competency cell scores and hard-gate signals. This is the precision-biased stage.

### 8.2 Core Computation

1. **Crawl plan** — for each candidate, fetch a prioritized page list:
   - `/` (homepage)
   - `/about` (company context, team size hints)
   - `/careers` or `/jobs` (**elevated priority** — densest architectural-fit signal via job listings)
   - `/docs` or docs.[company].com (if present)
   - `/blog`, `/engineering` (most recent 3-5 posts only)
   - Any "technology" or "architecture" pages linked from `/about`
   - **Cap: 10 pages per company** to bound cost and latency.
2. **Fetch via `PageFetcher` interface** (see §8.4). V1 implementation: Firecrawl.
3. **Extraction pass 1 — deterministic:**
   - Competency vocabulary matching per cell (keyword hit counts, context windows).
   - Tech-stack extraction from `/careers` (regex and list-parsing for Rust, Solidity, FunC, Node, Kubernetes, HSM, etc.).
   - Team-size detection ("team of N", "our X employees", first-5-hires language).
   - Stage-signal detection ("just raised", "Series A", "hiring our first...").
   - Anti-signal detection ("cheap developers", "outstaffing", "looking for vendor").
4. **Extraction pass 2 — LLM (conditional):**
   - Runs only when Pass 1 produces **ambiguous** results (defined operationally as: any cell score in the 0.3–0.7 uncertainty band after Pass 1).
   - Sends cleaned Markdown of the most-relevant pages to Claude with a structured output schema (Zod-defined) asking for per-cell relevance scores + evidence snippets.
   - Results overwrite Pass 1 scores for the affected cells with `extractionMethod: "llm"`.
5. **Aggregate scoring** — combine per-cell scores into an `aggregateScore` for review-queue prioritization. Weighting: multi-cell matches score higher than single-cell matches at equal per-cell strength.
6. **Emission** of `QualifiedCandidate` to the review queue.

### 8.3 Validation Strategy

Before Stage 2 goes live, it is validated against the **65-company labeled dataset** as ground truth:

- Run Stage 2 against the known websites of all 65 companies.
- Compare the qualifier's tier-prediction (based on aggregateScore thresholds) against the team's actual A/B/C assignments.
- **Target: ≥80% tier-agreement.**
- Specifically examine disagreements as calibration cases (especially Tier C rejections like Celebratix, Indicio, Warden — the qualifier should correctly classify these as low-match).

The validation fixture set (captured `FetchedPage` outputs for all 65) becomes the permanent test corpus for regression testing.

### 8.4 `PageFetcher` Interface

Firecrawl is the v1 implementation but is wrapped behind an interface so the rest of Stage 2 is Firecrawl-agnostic:

```typescript
interface PageFetcher {
  fetch(url: string, opts?: FetchOpts): Promise<FetchedPage>;
  crawl(baseUrl: string, opts?: CrawlOpts): Promise<FetchedPage[]>;
}

interface FetchedPage {
  url: string;
  markdown: string;           // cleaned, LLM-ready
  title: string;
  metadata: Record<string, unknown>;
  fetchedAt: Date;
}
```

Concrete implementations:
- `FirecrawlFetcher` — v1, calls Firecrawl API, maps response to `FetchedPage`.
- `FixturePageFetcher` — testing, loads `FetchedPage` from captured JSON fixtures. **Primary test dependency for Stage 2 tests.** No network.
- Future: `PlaywrightFetcher`, `MultiSourceFetcher` (fallback chain), `JinaReaderFetcher`.

### 8.5 Firecrawl-Specific Configuration

- **Endpoint:** Firecrawl's `/scrape` or `/crawl` REST API (Node SDK available).
- **JS rendering:** Enabled by default.
- **Content format:** Markdown (not HTML or raw).
- **Credit budget:** **[ASSUMPTION]** Mid-tier plan at ~$80/month, covering ~2000 page fetches. Monitored monthly.
- **Success criteria for continued use:** page-fetch success rate ≥95% on validation set; median latency < 15s/page; cost per `QualifiedCandidate` < $0.50. Degradation triggers alternatives evaluation.

### 8.6 Spec Location

`specs/website-qualifier/spec.md`. Expected AC count: ~30-40 (largest spec in the pipeline).

---

## 9. Stage 3: Human Review Queue

### 9.1 Responsibility

Present `QualifiedCandidate`s to a human reviewer in priority order, support efficient Crunchbase-based verification, and capture the reviewer's tier decision as a `TieredLead`.

### 9.2 Core Mechanics

- **Queue state:** `pending | inReview | tiered | dismissed`.
- **Priority ordering:** by `aggregateScore` descending, then by Stage 1 `discoveredAt` ascending (older freshness-value first within the same score band).
- **Reviewer UI:** shows the candidate's Stage 1 evidence (tweet), Stage 2 evidence (per-cell scores + supporting snippets), and direct links to their website and the Crunchbase search URL for the company name.
- **Capture fields** (what the reviewer fills in):
  - `tier`: A / B / C
  - `tierReason`: required free-text
  - `crunchbaseConfirmed`: did you find it in Crunchbase? Actual amount / stage / date?
  - `downgradeReasons` (if not A): from a controlled vocabulary (see §9.3) plus free-text.
- **Output:** `TieredLead` written to persistence; Tier A and Tier B feed the outreach queue, Tier C are archived for future fingerprint training.

### 9.3 Downgrade Reason Taxonomy

From analysis of the existing 65-company dataset, downgrade reasons fall into a small controlled vocabulary:

- `competency_mismatch` — no matrix cell matches (most common Tier C).
- `wrong_vertical` — competency matches but wrong industry (e.g., Indicio — DID for aviation).
- `business_risk_override` — reputation, legal, or integrity concern (e.g., Warden — token crashed).
- `stage_too_late` — already scaled, in-house team (e.g., Flying Tulip — $275M, own CISO).
- `stage_too_early` — sub-$2M, too little budget for MVA engagement.
- `founder_unreachable` — no identifiable founder/CTO, or not reachable via LinkedIn 2nd-degree network.
- `acquired_or_state_backed` — decision authority elsewhere (e.g., Future → H100, Neng Lian → state capital).

These codes feed analytics and help tune upstream stages over time.

### 9.4 Lead-Time Measurement

When the reviewer checks Crunchbase and either finds or does not find the round:

- **Found and date available:** compute `leadTimeDays = claimedAt (X) – actualDate (Crunchbase)`. Positive = X was faster.
- **Not yet in Crunchbase:** log `foundInCrunchbase: false` with `reviewedAt` timestamp. The reviewer can re-check on a later queued reminder to capture the delayed indexing.

Aggregate these measurements monthly. **The X stage is justified if and only if median `leadTimeDays` ≥ 14 days** (see §2 foundation window rationale). If median lead time is low over the first 3 months of operation, the X stage is a candidate for replacement or deprioritization.

### 9.5 Spec Location

`specs/review-queue/spec.md`. Expected AC count: ~15-20.

---

## 10. Competency Fingerprint

### 10.1 Responsibility

Turn the typed `ICPReference` (matrix + 65-company dataset + reference clients) into the per-cell vocabulary and pattern structures consumed by Stages 1 and 2.

### 10.2 Computation

1. For each competency cell, collect:
   - Keyword markers from the matrix definition (§3).
   - Tech-stack mentions from Tier A product descriptions assigned to that cell.
   - Tech-stack mentions from reference clients (weighted 2×).
2. Compute **term frequency × discriminative power**: a term is more valuable when it appears in Tier A of a cell *and does not appear* in Tier C examples. This naturally surfaces the terms that distinguish Avenia's profile from Celebratix's.
3. Output per-cell:
   - `primaryVocabulary`: top 20-30 discriminative terms.
   - `secondaryVocabulary`: 30-50 supporting terms.
   - `antiVocabulary`: terms associated with Tier C (useful as negative evidence).
4. Persist to `data/fingerprint.json` (or similar), versioned, regenerated when the ICPReference changes.

### 10.3 Spec Location

`specs/competency-matrix/spec.md` (includes fingerprint computation). Expected AC count: ~20.

---

## 11. Validation, Measurement, and Feedback

### 11.1 Pre-Launch Validation (Before Stage 1 Goes Live)

- Stage 2 run against all 65 labeled companies.
- Tier-agreement computed and reviewed.
- Specific failure cases (Tier C false positives, Tier A false negatives) analyzed and used to adjust competency vocabulary or scoring thresholds.
- Threshold: ≥80% tier-agreement before Stage 1 is connected.

### 11.2 Continuous Measurement

Once live, the pipeline logs and reports monthly:

- **Stage 1 output rate** (FundingSignals/week).
- **Stage 2 pass rate** (QualifiedCandidate / FundingSignal).
- **Stage 3 tier distribution** (A/B/C percentages of reviewed candidates).
- **Review queue latency** (time from qualified → reviewed).
- **Lead time over Crunchbase** (median, from §9.4).
- **Cost per Tier A/B output** (amortized Firecrawl + X API + Claude costs).
- **Per-cell hit rates** (which matrix cells are producing the most Tier A, and which are starving).

### 11.3 Feedback Loop

- **Every 3 months:** revisit the competency fingerprint. New Tier A acquisitions should be added to the training set.
- **Every 6 months:** review downgrade-reason distribution. If a particular code (e.g., `wrong_vertical`) is dominant, that's a signal Stage 2 needs more vertical-awareness.
- **Ad-hoc:** whenever an outreach succeeds and closes, trace back through the pipeline logs. Was it surfaced cleanly? Which signals led to the match? Feed back into fingerprint.

---

## 12. Out of Scope (Explicit Non-Goals)

- **Crunchbase programmatic scraping.** Not ToS-legitimate. Used only via human review.
- **LinkedIn scraping for discovery.** Not ToS-legitimate. LinkedIn reserved for outreach.
- **Automated tier-final decisions.** Human review is a feature, not a bug.
- **Cold LLM-only scoring.** LLM extraction is a second pass on ambiguous candidates only, not the primary scoring mechanism.
- **Real-time outreach triggering.** Outreach is a separate system; this pipeline's output is a queue, not an action trigger.
- **Multi-language content processing.** English only.
- **Serving FinScout's existing `/v1/discovery/evaluate` API.** That endpoint is currently served by legacy `src/services/discoveryEngine.ts`. Re-wiring to the new pipeline is a separate migration (see §13).

---

## 13. Relationship to Existing FinScout Architecture

The pipeline lives inside the FinScout codebase. Module layout:

```
finscout-ai-agents/
├── src/
│   ├── sales-factory/              # EXISTING — iDECP, unchanged
│   ├── discovery/                  # EXTENDED — new modules added
│   │   ├── XDiscoverySource.ts     # EXISTING
│   │   ├── XFundingListener.ts     # NEW — Stage 1
│   │   ├── WebsiteQualifier.ts     # NEW — Stage 2
│   │   ├── ReviewQueue.ts          # NEW — Stage 3
│   │   ├── CompetencyFingerprint.ts # NEW
│   │   └── sources/
│   │       ├── PageFetcher.ts      # NEW — interface
│   │       ├── FirecrawlFetcher.ts # NEW — Firecrawl impl
│   │       └── FixturePageFetcher.ts # NEW — test impl
│   ├── schema/
│   │   ├── lead.schema.ts          # EXISTING — reused
│   │   ├── fundingSignal.ts        # NEW
│   │   ├── qualifiedCandidate.ts   # NEW
│   │   └── tieredLead.ts           # NEW
│   └── services/                   # LEGACY — untouched this phase
├── specs/
│   ├── sales-factory/              # EXISTING
│   ├── discovery/                  # NEW — retroactive spec for XDiscoverySource
│   ├── competency-matrix/          # NEW
│   ├── x-funding-listener/         # NEW
│   ├── website-qualifier/          # NEW
│   └── review-queue/               # NEW
└── data/
    ├── icp-reference.json          # 65-company dataset + reference clients
    ├── fingerprint.json            # Generated competency fingerprint
    └── fixtures/
        └── pages/                  # Captured page fixtures for validation
```

### 13.1 Retroactive Spec for `XDiscoverySource`

The existing `XDiscoverySource.ts` has 18 passing tests but no spec. Before Stage 1 is built, write `specs/discovery/spec.md` retroactively to bring the existing module under the iDECP protocol umbrella. This closes the protocol-compliance gap and establishes the conventions Stage 1's spec will follow.

### 13.2 Legacy/iDECP Fork

The pipeline builds on the iDECP side (`src/sales-factory/`, `src/discovery/`) and does not attempt to re-wire the existing Express endpoints (`/v1/discovery/evaluate`, `/v1/research/synthesize`). The endpoints stay on legacy `src/services/*` until a separate migration effort. **Expect the iDECP side to grow "built but not wired" while this effort proceeds**; accept this tradeoff consciously.

---

## 14. Sequencing and Dependencies

The specs are written and implemented in this order:

1. **`specs/discovery/spec.md`** (retroactive, for existing `XDiscoverySource`) — closes protocol gap.
2. **`specs/competency-matrix/spec.md`** — no dependencies; defines the spine.
3. **`specs/website-qualifier/spec.md`** — depends on competency-matrix; built and validated against 65-company set *before* any Stage 1 work.
4. **`specs/x-funding-listener/spec.md`** — depends on competency-matrix; connects to website-qualifier once qualifier is validated.
5. **`specs/review-queue/spec.md`** — can be written in parallel with qualifier; connects last.

Stage 2 validation is the **gate** between "pipeline exists on paper" and "pipeline is running in production." Do not launch Stage 1 until Stage 2 hits the 80% tier-agreement target on the validation set.

---

## 15. Open Questions (For Review)

These are the **[ASSUMPTION]**-marked items collected for explicit confirmation:

1. **Cluster 1/2/3 ↔ Competency Matrix relationship** (§3.1): confirmed orthogonal? Clusters are market-side; matrix is supply-side?
2. **Reference clients as fingerprint seeds** (§3.2): confirmed yes, parallel to the 65-company ICP?
3. **Deployment model** (§2): Docker Compose matching existing FinScout pattern?
4. **Budget ceiling** (§2): ~$150/month total external services acceptable?
5. **X API tier** (§7.3): Basic ($100/mo) appropriate?
6. **Firecrawl pricing tier** (§8.5): ~$80/mo mid-tier acceptable?
7. **Historical X-vs-Crunchbase lead time**: any anecdotal data points available, or measure from day one?
8. **Reviewer identity** (§9.2): one person, a rotating role, or multiple reviewers? Affects the review UI's authentication / attribution needs.
9. **Persistence layer** for the pipeline's state: SQLite in the Docker volume, or Postgres, or something else matching existing FinScout patterns?
10. **Who owns the `ICPReference` data**: Is there a canonical English spreadsheet that will be imported, or does the team re-author the 65 records directly in the new schema?

---

## 16. Success Criteria

This architecture document is a success if:

- The four specs underneath it (`competency-matrix`, `website-qualifier`, `x-funding-listener`, `review-queue`) can be written without re-opening structural questions.
- An implementer can explain the pipeline end-to-end from this document alone.
- The validation strategy (Stage 2 against 65 labeled companies) is concrete enough to execute.
- Open items are either resolved in review or explicitly deferred with a named owner.

The pipeline as a whole is a success when:

- 25 reviewable candidates/week are consistently reaching the review queue.
- ≥70% of reviewed candidates become Tier A or Tier B.
- Median lead-time over Crunchbase is ≥14 days.
- The founder (or designated reviewer) spends ≤90 minutes/week on review.
- Outreach throughput is the bottleneck, not discovery throughput.

---

*End of discovery-architecture.md v0.1*
