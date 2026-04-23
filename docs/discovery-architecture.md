# Discovery Architecture

> **Classification:** Internal — Engineering
> **Status:** Pre-spec architecture document (v0.2)
> **Scope:** The FinScout lead-discovery pipeline — from public signal to human-reviewed outreach candidate
> **Audience:** Anyone implementing or reviewing specs for the Phase 1 modules (`enriched-profile`, `fingerprint`, `enrichment-engine`, `x-signal-source`, `review-queue`).

This document captures the architectural decisions that shape the FinScout discovery pipeline. It is the parent document for the five Phase 1 module specs that follow. Its purpose is to pin down *interfaces, contracts, and constraints* so that spec authors and implementers do not re-litigate structural questions during TDD.

Where decisions were made with incomplete information, assumptions are marked **[ASSUMPTION]** and must be confirmed or corrected during review.

---

## Changelog

### v0.2 (supersedes v0.1)

The architecture in v0.1 was a single three-stage pipeline (X listener → Website qualifier → Review queue). After design review, the pipeline was split into two modules with a typed contract between them, and Phase 1 was reframed as live-signal validation rather than labeled-set reproduction. Specific changes:

- **NEW: Two-module architecture.** `EnrichmentEngine` (Module A) and `ScoringAgent` (Module B) are now separate modules connected by the `EnrichedProfile` Zod schema. Phase 1 builds Module A only; Module B is explicitly out of scope until Phase 1 exits.
- **NEW: Module A is validated by live X signal with manual review**, not by automated reproduction against the 65-company labeled set. The 65-company set has a dual role: upstream as fingerprint training input; downstream as scoring-validation ground truth in Phase 2.
- **NEW: Phase 1 Definition of Done is a hard quality gate.** 25-40 enriched profiles reviewed, ≥80% must support confident tier decisions from profile content alone without external lookup. Encoded as an explicit AC in `specs/review-queue/spec.md`.
- **NEW: Fingerprint is human-in-the-loop, AI-assisted, with Core+Cell inheritance.** Shared `core-web3-signals` and `core-web3-anti-signals` are extended by per-cell fingerprints. CLI-driven curation workflow; version-controlled JSON artifacts.
- **NEW: Structured missing-evidence logging.** Reviewer annotations use a Zod enum (`missing_tech_stack`, `missing_traction_signal`, `missing_founder_context`, `missing_architecture_signal`, `noise_false_positive`) plus free-text notes. Aggregates into prioritized enrichment-improvement backlog.
- **NEW: Staged pre-filter in Module A.** Cheap deterministic filters (template match → anti-vocabulary exclusion → vocabulary density → company resolution) run before any Firecrawl call. Full enrichment runs only on tweets that pass the pre-filter. Manages Web3-volume signal without blowing the budget.
- **REMOVED: "Crunchbase backstop" as an automated stage.** Crunchbase remains a manual step used by the reviewer during Stage 3; no programmatic access is attempted.
- **REMOVED: The `[ASSUMPTION]`/§15 reconciliation issue from v0.1.** Resolved assumptions are now inline; remaining open items consolidated in §15 and counted consistently.
- **REMOVED: `founder_unreachable` from the `DowngradeReason` enum.** Per MVA/YAGNI discipline — Phase 1 has no automated LinkedIn enrichment, so the enum reflects current reality. Reintroduced in Phase 2 when the LinkedIn connector spec lands.
- **RESOLVED from v0.1 §15:** English-only pipeline (confirmed); per-cell fingerprints with Core inheritance (confirmed); reference clients feed fingerprint (confirmed, with lower weight than v0.1 proposed — see §10); Firecrawl as Stage 2 fetcher (confirmed); ~$150/month budget target (confirmed comfortable at Phase 1 volumes).

---

## 1. Thesis

FinScout sells MVA (Minimum Viable Architecture) engineering services to early-stage fintech and Web3 startups. The Sales Factory's job is to find companies that are (a) at a stage where MVA work fits (pre-scale, pre-rewrite), and (b) building a product whose architecture maps to RadianceTeam's competency matrix.

The **central thesis** of this architecture is:

> **X is the only programmatically-accessible discovery channel that produces fresh signal before competitors act on it.** Crunchbase is authoritative but lags and is not legitimately scrapable. LinkedIn is rich but scrape-hostile for discovery. Company websites are the authoritative qualification source but are found, not discovered. X is where founders announce their rounds *before* those rounds show up in any structured database — and every week of lead time preserved at the discovery layer is a week preserved in the 6-12-week MVA foundation-decision window.

The pipeline is designed around this asymmetry: **X for discovery, websites for qualification, human judgment for tier assignment, Crunchbase (manual) for verification.**

A second thesis, established in v0.2:

> **Enrichment and scoring are different engineering problems with different failure modes.** Enrichment fails on coverage and freshness; scoring fails on judgment and calibration. Mixing them means every failure is ambiguous. Separating them makes each independently testable and independently improvable. Phase 1 establishes a rock-solid data foundation (Module A only); Phase 2 layers scoring on top.

---

## 2. Constraints That Shaped the Design

- **ToS-legitimate data access only.** X has a real API; we use it. Crunchbase and LinkedIn are both scrape-hostile at the API level. We do not scrape them for discovery. Crunchbase appears in the pipeline only as a human-reviewed verification step. LinkedIn is reserved entirely for outreach (a separate concern, not this pipeline).
- **Target throughput (steady state): 25 reviewable candidates per week.** Phase 1 operates below this; live validation expects to hit 25-40 profiles in days, not weeks, given Web3-X signal density.
- **65-company labeled dataset** (38 Tier A, 14 Tier B, 14 Tier C) — fingerprint training input in Phase 1; scoring validation ground truth in Phase 2.
- **English-only pipeline** end to end — data, schemas, prompts, review queue, logs. The English version of the ICP sheet is canonical.
- **Competency matrix (5 cells)** from the RadianceTeam sales deck is the authoritative ICP reference. See §3.
- **Foundation-window business model.** Target companies are $2M–$35M funded, Pre-Seed through Series A, within ~6-12 weeks of their foundation-architecture decisions.
- **Deployment model:** Docker Compose, matching the pattern in the FinScout README (`docker compose up -d finscout-discovery-engine`).
- **Budget ceiling for external services: ~$150/month.** Comfortable at Phase 1 volumes (Firecrawl mid-tier ~$80, X API Basic ~$100 — slight overage absorbed since Claude API costs are minimal at current scale, and no Firecrawl volume pressure in Phase 1).
- **Existing FinScout codebase:** Node 20, TypeScript 5.x, Jest 30, Zod v4, Express. The pipeline lives inside this codebase, not as a separate service.
- **Protocol compliance:** All new modules follow the iDECP protocol — spec first, test scaffold, red-green TDD, Zod-validated interfaces, pure logic separated from I/O.
- **CLI-first tooling for human-in-loop workflows.** No web UIs in Phase 1. Fingerprint curation, review queue interaction, and validation are all CLI commands integrating with the `.agents/commands/` slash-command pattern already established.

---

## 3. The Competency Matrix as Spine

The competency matrix is the single authoritative definition of what FinScout's ICP actually is. It comes from the RadianceTeam deck (slide 11) and consists of five cells:

| Cell | Description | Keyword Markers (representative) | Example Tier A Matches |
|------|-------------|----------------------------------|------------------------|
| **DeFi & Yield** | Stablecoins (TRON, ETH, TON), Rebase mechanisms, Staking logic | stablecoin, rebase, yield, staking, TVL, liquidity provisioning, flash loan resistance | Avenia, Bleap, Levl, YO Labs, LumeFi |
| **Trading** | Margin trading engines, Risk management blocks, DEX/AMM forks | margin, liquidation, AMM, DEX, order book, MEV, risk engine | Architect, Penguin Sec., RateX, fomo, Hello Trade |
| **Infrastructure** | Cross-chain bridges, Multisig governance, High-load microservices | cross-chain, bridge, multisig, throughput, settlement finality, bare-metal cores | Rift, Euclid, Sprinter, Superset, Firefish, Bitway |
| **Security** | Audited smart contracts, HSM software modules, Cryptography, Decentralized ID | HSM, audit, formal verification, multisig, KMS, DID, institutional custody | CheckSig, Deblock, Axiology, Tenbin Labs, OpenEden |
| **Payment Rails** | SBP integration, Fiat-to-Crypto gateways | Fiat-to-Crypto, gateway, settlement, on-ramp, off-ramp, AML, compliance automation | Ruvo, PEXX, Nodu, Based, Netaro |

Cells are fingerprinted **independently** (see §10) with a shared core. A company may match multiple cells; multi-cell matches are stronger signals (indicating broader architectural need). In Phase 1, cell matching feeds reviewer context; in Phase 2, it drives automated scoring.

### 3.1 Relationship to the Cluster 1/2/3 Taxonomy

The ICP spreadsheet uses Cluster 1 (Stablecoins & Custody), Cluster 2 (RWA & Tokenization), Cluster 3 (Trading/DEX/Yield) as groupings.

**[ASSUMPTION — confirm in review]** These clusters are *market-facing product categories* — how the market and Crunchbase describe these companies. They are **orthogonal** to the competency matrix, which captures *RadianceTeam's supply-side capabilities*. A single company has both attributes:

- `productCluster` (market-side): derived from Crunchbase sector and the company's own product description.
- `competencyCellMatches` (supply-side): computed by the fingerprint against the 5 cells.

Clusters are used for **reporting and human navigation** (e.g., "show me this week's reviewed profiles in Cluster 1"). Scoring and prioritization run on competency cells.

### 3.2 Reference Clients as Fingerprint Seeds

RadianceTeam's existing customer case studies (the stablecoin management system operating at billion-dollar volumes per the deck, and any others) are treated as a parallel dataset alongside the 65-company ICP:

```
ICPReference = {
  crunchbaseICP: ICPMember[],      // The 65 from the current labeled list
  referenceClients: ICPMember[],   // Existing RadianceTeam customers
}
```

Both feed the competency fingerprint during the curation workflow. Reference clients are **weighted higher** in AI-suggestion vocabulary extraction because they are ground-truth positive examples of successful MVA engagements. Final fingerprint terms are human-curated regardless of source weighting (see §10).

---

## 4. Pipeline Overview — Two Modules, One Contract

```
                    ICPReference
                   (matrix + 65 companies + ref clients)
                           │
                           ▼
            ┌──────────────────────────┐
            │  Fingerprint Authoring   │   Phase 0 / ongoing
            │  (human-in-the-loop,     │   CLI workflow
            │   AI-assisted curation)  │   Versioned JSON artifacts
            └──────────┬───────────────┘
                       │
                       ▼
            ┌──────────────────────────┐
            │  data/fingerprints/      │
            │  ├── core-web3-signals   │
            │  ├── core-web3-anti-     │
            │  │   signals             │
            │  └── cells/              │
            │      ├── defi-&-yield    │
            │      ├── trading         │
            │      ├── infrastructure  │
            │      ├── security        │
            │      └── payment-rails   │
            └──────────┬───────────────┘
                       │
                       ▼
       ┌───────────────────────────────────┐
       │   MODULE A — Enrichment Engine    │   PHASE 1 SCOPE
       │   ┌───────────────────────────┐   │
       │   │  X Signal Source           │   │   ← live X firehose
       │   │  (funding template match  │   │   ← cheap pre-filter
       │   │   + anti-vocab exclusion  │   │   ← company resolution
       │   │   + vocab density)        │   │
       │   └────────────┬──────────────┘   │
       │                ▼                   │
       │   ┌───────────────────────────┐   │
       │   │  Website Enrichment       │   │   ← Firecrawl
       │   │  (crawl, extract,         │   │   ← careers, docs,
       │   │   architecture signals)   │   │     about, blog
       │   └────────────┬──────────────┘   │
       │                ▼                   │
       │   ┌───────────────────────────┐   │
       │   │  Profile Composer         │   │   ← merges X + website
       │   │  (builds EnrichedProfile)│   │     + freshness +
       │   │                           │   │     provenance
       │   └────────────┬──────────────┘   │
       └────────────────┼──────────────────┘
                        ▼
                   EnrichedProfile   ◄──── THE CONTRACT
                        │
                        │  (persisted, inspectable,
                        │   replayable, versionable)
                        │
                        ▼
       ┌───────────────────────────────────┐
       │   Review Queue (Phase 1)          │   PHASE 1 SCOPE
       │   - reviewer reads profile        │
       │   - assigns tier A/B/C manually   │
       │   - logs missing_evidence_types  │
       │   - logs free-text reviewerNote  │
       │   - measures Phase 1 adequacy AC  │
       └───────────────────┬───────────────┘
                           │
                           ▼
                     TieredLead
                     (to outreach queue,
                      manual LinkedIn process)
```

The dashed boundary below is **Phase 2** and is deliberately out of scope for this document:

```
       ┌───────────────────────────────────┐
       │   MODULE B — Scoring Agent        │   PHASE 2 (NOT YET BUILT)
       │   Consumes EnrichedProfile        │
       │   Proposes tier assignment        │
       │   Validated against 65-company    │
       │     labeled set                   │
       └───────────────────────────────────┘
```

---

## 5. Throughput and Phase 1 Volume

### 5.1 Expected Phase 1 volume

Web3/crypto X signal is dense. A strictly-tuned competency fingerprint is expected to surface candidates at roughly 5-10 per day — meaning the 25-40 profile threshold for Phase 1 DoD is reached within a week, not the 8-16 weeks a conservative fintech estimate would produce.

### 5.2 Phase 1 risk profile

The dominant risk is **over-volume from an insufficiently-strict fingerprint**, not under-volume. Review time is the bottleneck. The fingerprint starts strict and is relaxed only if empirical evidence shows the funnel is starving.

### 5.3 Steady-state targets (post-Phase 1, for reference)

| Stage | Weekly output | Pass rate |
|-------|--------------|-----------|
| X Signal Source | ~50-65 candidates/wk pass pre-filter | N/A (filter) |
| Website Enrichment | ~25 EnrichedProfiles/wk | ~40-60% |
| Phase 2 Scoring → Review | ~18-20 Tier A/B/wk | ~70-80% A/B after review |

### 5.4 Phase 1 Definition of Done

**Enrichment is approved when:**

- At least 25 (target: 25-40) EnrichedProfiles have been produced from live X signal and reviewed.
- For ≥80% of reviewed profiles, the reviewer can confidently assign a tier (A, B, or C) using only the EnrichedProfile content — without opening Crunchbase, LinkedIn, or the company website.
- Profiles failing the adequacy test are tagged with at least one `missing_evidence_type` enum value plus a free-text note.
- Aggregated failure modes have been reviewed; no single `missing_evidence_type` dominates >40% of failures (indicating that enrichment has no single-point systematic gap).

The DoD is encoded as an explicit AC in `specs/review-queue/spec.md`. It is a hard quality gate — Module B work does not begin until this AC passes.

### 5.5 Outreach capacity tension (unchanged from v0.1)

**[FLAG]** The steady-state rate of 18-20 Tier A/B/week will likely exceed current manual outreach throughput. This is a downstream concern; Phase 1 does not surface it. Once Module B is running, tighten Stage 2 or scale outreach (the LinkedIn-connector module discussed separately). Do not hardcode scoring thresholds.

---

## 6. Stage Contracts

### 6.1 `EnrichedProfile` — Module A → Review Queue → (Module B in Phase 2)

This is the central contract of the architecture. Full Zod schema is specified in `specs/enriched-profile/spec.md`; the shape is pinned here.

```typescript
EnrichedProfile = {
  id: string;                          // uuid
  enrichedAt: Date;
  schemaVersion: string;               // semver, for forward migration

  // Sources and freshness — provenance per-field is tracked in sources
  sources: {
    xApi?: {
      lastFetched: Date;
      tweetsConsidered: number;
      founderHandle?: string;
    };
    websiteCrawl?: {
      lastFetched: Date;
      pagesCrawled: URL[];
      fetcher: "firecrawl" | string;   // swappable impl audit trail
    };
    // future: crunchbaseManual, predictLeads, etc.
  };

  // Identity
  company: {
    name: string;
    normalizedName: string;
    websiteUrl: URL;
    xHandle?: string;
    linkedinUrl?: URL;                 // captured but not used in Phase 1
    country?: string;                  // inferred or explicit
  };

  // Funding — claimed (from X or announcement); confirmed filled at review
  funding: {
    claimed: {
      amountUSD?: number;
      stage?: FundingStage;
      claimedAt?: Date;
      announcementUrl?: URL;
      rawText?: string;                // source tweet or press release text
      templateMatched?: string[];      // which funding-announcement patterns fired
    };
    confirmed?: {                      // reviewer fills from Crunchbase
      amountUSD?: number;
      stage?: FundingStage;
      closedAt?: Date;
      investors?: string[];
      leadTimeDays?: number;           // claimedAt → closedAt
      foundInCrunchbase: boolean;
    };
  };

  // Product and architecture (from website)
  product: {
    description?: string;              // from /about or homepage
    selfClaimedCategory?: string;      // e.g., "stablecoin infrastructure"
    stackMentions: string[];           // from /careers, docs, engineering
    architectureTerms: string[];       // multisig, HSM, cross-chain, bare-metal, etc.
    antiSignalTerms: string[];         // outstaffing, cheap, etc.
    competencyCellMatches: Array<{
      cell: CompetencyCell;            // which of the 5 cells fired
      matchedSignals: string[];        // specific terms that matched
      matchedCoreSignals: string[];    // which core vocabulary fired
      score: number;                   // 0.0-1.0 vocabulary density
    }>;
    evidence: Array<{
      page: URL;
      snippet: string;
      relevance: "high" | "medium" | "low";
      relatedCells?: CompetencyCell[];
    }>;
  };

  // Team signals
  team: {
    estimatedHeadcount?: number;
    headcountSource?: "about_page" | "careers_count" | "unknown";
    founders: Array<{
      name?: string;
      role?: string;
      xHandle?: string;
      linkedinUrl?: URL;
      bioSnippet?: string;
      isFoundingEngineer?: boolean;
    }>;
    openRoles?: Array<{
      title: string;
      stackHints: string[];
      seniority?: "junior" | "mid" | "senior" | "lead";
    }>;
  };

  // Raw content retained for reprocessing — disk is cheap, re-crawl is expensive
  rawContent: {
    websiteMarkdown: Record<string, string>;  // url → markdown
    sourceTweets?: Array<{
      id: string;
      text: string;
      postedAt: Date;
      authorHandle: string;
      authorBio?: string;
    }>;
  };
};
```

Notice what's not in `EnrichedProfile`: **no tier, no overall score, no "fit" verdict**. Those are Module B concerns. Module A describes; Module B judges.

### 6.2 Reviewer Annotation — attached to `EnrichedProfile` at review time

```typescript
ReviewAnnotation = {
  profileId: string;
  reviewedAt: Date;
  reviewedBy: string;                  // for audit

  // Phase 1 adequacy measurement
  profileAdequate: boolean;            // could tier be assigned from profile alone?
  missingEvidenceTypes: MissingEvidenceType[];  // empty if adequate
  reviewerNote?: string;               // free-text context, especially for adequate=false

  // Tier decision (manual in Phase 1)
  tier: "A" | "B" | "C";
  tierReason: string;
  downgradeReasons?: DowngradeReason[];

  // Crunchbase cross-reference captured during review
  crunchbaseCheck: {
    checked: boolean;
    foundInCrunchbase?: boolean;
    actualAmountUSD?: number;
    actualStage?: FundingStage;
    actualDate?: Date;
  };
};

// Phase 1 starting vocabulary; extend as patterns emerge
MissingEvidenceType =
  | "missing_tech_stack"
  | "missing_traction_signal"
  | "missing_founder_context"
  | "missing_architecture_signal"
  | "noise_false_positive";

// From existing Tier C analysis in the 65-company dataset.
// `founder_unreachable` removed per MVA/YAGNI — reintroduce in Phase 2
// when the LinkedIn connector lands.
DowngradeReason =
  | "competency_mismatch"
  | "wrong_vertical"
  | "business_risk_override"
  | "stage_too_late"
  | "stage_too_early"
  | "acquired_or_state_backed";
```

### 6.3 Out-of-scope: `ScoredCandidate`

Phase 2 introduces a `ScoredCandidate` shape that wraps `EnrichedProfile` with Module B's automated tier prediction. Its schema is explicitly not specified in this document. It will be pinned in the Phase 2 architecture addendum written after Phase 1 DoD is hit.

---

## 7. Module A — Enrichment Engine

### 7.1 Responsibility

Given live X signal, produce `EnrichedProfile` records with sufficient depth and accuracy that a human reviewer can make confident tier decisions from profile content alone.

### 7.2 Internal structure

Module A has three internal sub-modules, each with its own spec:

- **X Signal Source** (`specs/x-signal-source/`) — funding-announcement template matching, vocabulary-density filtering, anti-vocabulary exclusion, company resolution. Outputs a stream of `CompanyCandidate` (internal shape) into the website enrichment queue.
- **Website Enrichment** (inside `specs/enrichment-engine/`) — Firecrawl-based crawl of `/`, `/about`, `/careers`, `/docs`, `/blog`, `/engineering`. Deterministic extraction of architecture signals, stack mentions, team signals.
- **Profile Composer** (inside `specs/enrichment-engine/`) — merges X-sourced data and website-sourced data into the final `EnrichedProfile`, computes per-cell competency matches using the loaded fingerprint, attaches evidence snippets with provenance.

### 7.3 Staged pre-filter (load-bearing design)

The X-signal firehose is too dense to enrich every match. Filters run in order, cheapest and highest-rejection-yield first. **Anti-vocabulary exclusion runs before primary vocabulary density** because retail/speculation noise in Web3-X is categorically disqualifying regardless of what other signals are present — a tweet containing "airdrop" is not a funding-announcement signal we care about even if it also contains "multisig."

1. **Tweet template match** (deterministic regex) — does this tweet resemble a funding announcement? Free. Reject immediately if no template fires.
2. **Anti-vocabulary exclusion** (deterministic) — does the tweet or the author's bio contain any term from `core-web3-anti-signals` or cell-level anti-signals (`airdrop`, `100x`, `degen`, `diamond hands`, `moonshot`, etc.)? Free. **Immediate reject if any anti-signal fires**, regardless of what primary signals may also be present. Retail noise disqualifies.
3. **Primary vocabulary density** (deterministic) — does the tweet or bio contain ≥N terms from the core primary signals or from at least one cell's primary signals? Free. Reject if density threshold not met.
4. **Company resolution** (cheap API call or cache) — can we resolve the company to a website URL? Minor cost. Reject if unresolvable.
5. **Website enrichment** (Firecrawl) — full crawl + extraction. Only runs on candidates that pass filters 1-4.

This staging is why Module A stays within budget even at Web3-X volumes. The first three filters are free and do the bulk of noise rejection; filter 4 is cheap; expensive Firecrawl enrichment runs only on candidates that have already survived a gauntlet of free checks.

A note on filter 2's position: it is the single highest-yield rejection in Web3-X. At volumes of 5-10 tweets per second carrying competency-adjacent vocabulary, the overwhelming majority are retail speculation, not institutional-grade buying signals. Running this filter before primary-density means we never waste compute on density calculations for tweets that were going to be rejected anyway. Empirically, this ordering is expected to drop 80%+ of incoming tweets before any further processing.

### 7.4 Firecrawl-specific configuration

- **Endpoint:** Firecrawl's `/scrape` and `/crawl` REST API, via the Node SDK.
- **JS rendering:** enabled by default.
- **Content format:** Markdown.
- **Credit budget:** ~$80/month mid-tier, comfortably fits Phase 1 volumes (est. <1000 pages/week under the staged pre-filter).
- **Wrapped behind `PageFetcher` interface** (see §7.5) so Firecrawl can be swapped without touching extraction logic.
- **Success criteria for continued use:** page-fetch success rate ≥95% on encountered sites; median latency <15s/page; cost per `EnrichedProfile` < $0.50. Degradation triggers alternatives evaluation.

### 7.5 `PageFetcher` interface

Firecrawl is the v1 implementation but is wrapped so the rest of Module A is Firecrawl-agnostic:

```typescript
interface PageFetcher {
  fetch(url: string, opts?: FetchOpts): Promise<FetchedPage>;
  crawl(baseUrl: string, opts?: CrawlOpts): Promise<FetchedPage[]>;
}

interface FetchedPage {
  url: string;
  markdown: string;                    // cleaned, LLM-ready
  title: string;
  metadata: Record<string, unknown>;
  fetchedAt: Date;
}
```

Concrete implementations in Phase 1:

- `FirecrawlFetcher` — v1 production path, calls Firecrawl via Node SDK, maps to `FetchedPage`.
- `FixturePageFetcher` — loads from `data/fixtures/pages/` JSON. **Primary test dependency** for Module A. No network.

Future (post-Phase 1 if needed): `PlaywrightFetcher`, `MultiSourceFetcher` (fallback chain), `JinaReaderFetcher`.

### 7.6 Spec locations

- `specs/enrichment-engine/spec.md` — Module A orchestrator + Website Enrichment + Profile Composer.
- `specs/x-signal-source/spec.md` — the X-specific sub-module.
- `specs/enriched-profile/spec.md` — the output contract schema (dependency of both above).

---

## 8. Phase 1 Review Queue

### 8.1 Responsibility

Present each `EnrichedProfile` to the reviewer in priority order. Capture (a) adequacy judgment + missing evidence types, (b) tier decision + reasons, (c) Crunchbase cross-reference during review. Measure progress against Phase 1 DoD.

### 8.2 Reviewer workflow (CLI-driven)

```bash
npm run review:next              # opens next queued profile
npm run review:stats             # progress toward DoD: N/40 profiles, adequacy rate
npm run review:export            # dumps ReviewAnnotation records for analysis
```

The `review:next` command displays:

- Compact summary of the `EnrichedProfile` (company, funding claim, cell matches, top evidence snippets).
- Direct terminal links: website, X profile, Crunchbase search URL.
- Interactive prompts for adequacy judgment, missing-evidence tags, tier, reasons, Crunchbase-check result.
- Writes `ReviewAnnotation` to persistence.

### 8.3 Persistence

**[ASSUMPTION — confirm in review]** SQLite via `better-sqlite3`, stored under `data/review-queue.db`. Rationale: zero-config, single-file, matches solo-operator scale for Phase 1; Postgres is overkill until multi-reviewer becomes real. If Phase 1 review reveals need for concurrent review or web UI, migrate at that point.

### 8.4 Phase 1 DoD measurement

The `review:stats` command computes:

- Total profiles reviewed.
- Adequacy rate (% of profiles where `profileAdequate = true`).
- Distribution of `missingEvidenceTypes` across inadequate profiles.
- Tier distribution (A/B/C counts among adequately-reviewable profiles).

Phase 1 exits when the DoD criteria from §5.4 are met. No earlier.

### 8.5 Iteration loop

When a profile is marked inadequate, the missing-evidence annotation aggregates into the enrichment backlog. Example workflow:

- 20 profiles reviewed, 12 adequate (60% — below DoD bar).
- Of the 8 inadequate, 5 are tagged `missing_architecture_signal`.
- Backlog item: improve architecture extraction. Possible causes — not crawling deep enough, missing docs subdomains, regex gaps for bare-metal/HSM vocabulary.
- Fix enrichment, regenerate profiles for those companies (raw content is retained; re-enrichment is cheap re-extraction without re-crawl).
- Re-review.
- Continue until adequacy rate ≥80% and no single failure mode dominates >40%.

### 8.6 Lead-time measurement

When the reviewer's Crunchbase check finds a confirmed round, compute `leadTimeDays = claimedAt (X) - actualDate (Crunchbase)`. Persist on `EnrichedProfile.funding.confirmed`. Aggregate monthly. **The X stage is justified if and only if median `leadTimeDays` ≥ 14 days** over the Phase 1 review set. This is a secondary measurement — not a Phase 1 DoD condition, but a foundational-thesis check that informs whether to continue investing in X specifically.

### 8.7 Spec location

`specs/review-queue/spec.md`. Expected AC count: ~20-25 including the Phase 1 DoD AC.

---

## 9. Scoring Agent (Module B) — Phase 2

**Out of scope for this document beyond the section you're reading.**

Module B consumes `EnrichedProfile`, applies deterministic rule-based scoring against the competency fingerprint and hard gates, produces a tier prediction with reasoning. LLM-assisted scoring is a secondary pass on ambiguous cases only (not primary mechanism). Validated against the 65-company labeled dataset with a target ≥80% tier-agreement on known inputs before going live.

Phase 2 work begins when Phase 1 DoD is met. The architecture addendum for Module B will be written at that point, informed by learnings from the 25-40 reviewed profiles — specifically the patterns in `MissingEvidenceType` frequencies, the tier distributions observed, and edge cases identified during review.

This deferral is deliberate. Building Module B in parallel with Module A would require guessing at the scoring rubric before the data shape is known. Guesses compound. One module at a time.

---

## 10. Fingerprint Authoring — Human-in-the-Loop, AI-Assisted

### 10.1 Responsibility

Produce the versioned JSON artifacts under `data/fingerprints/` that Module A consumes. The fingerprint is as much FinScout's IP as the sales-factory scoring rubric — it encodes the domain expertise that distinguishes a Tier A infrastructure signal from noise.

### 10.2 Core+Cell inheritance model

```
data/fingerprints/
├── core-web3-signals.json         # universal B2B quality markers
├── core-web3-anti-signals.json    # universal retail/speculation noise
└── cells/
    ├── defi-&-yield.json          # extends core
    ├── trading.json               # extends core
    ├── infrastructure.json        # extends core
    ├── security.json              # extends core
    └── payment-rails.json         # extends core
```

**Core files** contain vocabulary universal across Web3/crypto targeting:
- *Primary signals:* terms that mark B2B institutional quality regardless of vertical (e.g., `multisig`, `audit`, `formal verification`, `settlement finality`).
- *Anti-signals:* terms that mark retail/speculation noise (e.g., `airdrop`, `100x`, `degen`, `diamond hands`, `moonshot`, `wen token`, `ape in`).

**Cell files** extend the core with vertical-specific vocabulary:
- *Primary signals:* cell-specific architectural terms (e.g., for DeFi & Yield: `TVL`, `liquidity provisioning`, `flash loan resistance`; for Infrastructure: `bare-metal cores`, `cross-chain settlement`; for Security: `HSM integration`, `institutional custody`).
- *Anti-signals:* cell-specific noise or wrong-vertical markers (e.g., for Security: `aviation`, `airline` — wrong-vertical markers that match Security vocabulary but indicate Tier C per the Indicio case in the 65-company dataset).

Resolution logic at runtime: `resolveFingerprint(cell)` loads the cell file, resolves `extends` references, merges (cell-specific overrides core on term collision), returns composed fingerprint. Zod-validated transformation.

### JSON schema (sketch)

```json
{
  "version": "1.0",
  "lastCurated": "2026-04-22",
  "curator": "dmitriy",
  "cell": "DeFi & Yield",
  "extends": ["core-web3-signals", "core-web3-anti-signals"],
  "primarySignals": [
    { "term": "TVL", "weight": 1.2, "notes": "total value locked" },
    { "term": "liquidity provisioning", "weight": 1.5 },
    { "term": "flash loan resistance", "weight": 2.0, "notes": "strong Tier A signal" }
  ],
  "antiSignals": [
    { "term": "rugpull", "weight": 1.0 }
  ]
}
```

Term weights are in the range `(0, 3]`. Weights are used in Phase 1 only for reviewer-facing match scoring display; in Phase 2, Module B may use them as inputs to automated tier prediction. Final semantics of weights at scoring time are deferred to the Phase 2 architecture addendum.

Inheritance resolution rules:

- `extends` is an array of filenames (without `.json`) of other fingerprint files. Resolution is shallow (one level) in Phase 1; multi-level inheritance is explicitly not supported unless a need emerges.
- Core files have no `extends` field. Cell files must have `extends` including at least `core-web3-signals` and `core-web3-anti-signals`.
- On term collision between core and cell, the cell's entry wins — allowing per-cell weight overrides or note enrichment without modifying core.
- On term collision between two core files (should not happen in practice), resolution fails validation; `fingerprint:validate` catches this.

### 10.3 CLI-driven curation workflow

Phase 1 workflow is solo-me, CLI-driven:

```bash
npm run fingerprint:suggest --cell=defi-&-yield
    # AI-assisted extraction from 65 companies + reference clients.
    # Produces proposed vocabulary additions as a staging JSON file.

npm run fingerprint:review --cell=defi-&-yield
    # Interactive review of proposed terms. Accept/reject each.
    # Approved terms merge into the cell file.

npm run fingerprint:compile
    # Resolves all extends, validates against Zod, produces runtime artifact.

npm run fingerprint:validate
    # Sanity checks: no duplicates, no contradictions between primary and anti,
    # all cells reference existing core files, all terms have weight in (0, 3].
```

When Tolya or other curators join later, the JSON artifacts become the Git PR review surface. No architectural change needed — just process change.

### 10.4 Reference-client weighting

During `fingerprint:suggest`, the AI extracts vocabulary candidates from both the 65-company Crunchbase set and the reference clients. Reference-client occurrences weight higher in ranking (e.g., 2×) because they are positive confirmed outcomes. However, **final acceptance of any term is manual** — the weighting only affects ranking in the reviewer's queue, not inclusion.

### 10.5 Spec location

`specs/fingerprint/spec.md`. Expected AC count: ~25-30 covering schema, resolution, CLI commands, and validation rules.

---

## 11. Validation, Measurement, and Feedback

### 11.1 Phase 1 validation (in force)

- Live X signal processed by Module A.
- Reviewer reviews 25-40 resulting profiles.
- Adequacy rate ≥80%; no single failure mode >40%.
- Lead-time measurement (§8.6) collected throughout.

### 11.2 Continuous measurement during Phase 1

The review queue produces:
- Daily/weekly adequacy rate trend.
- `MissingEvidenceType` frequency distribution.
- Tier distribution (informational only — no Module B yet).
- Lead-time distribution.
- Per-cell match frequency (which cells are producing the most surfaced candidates).
- Firecrawl cost per EnrichedProfile.

### 11.3 Phase 2 validation (future)

When Module B is built:
- Run against the 65-company labeled set.
- Target: ≥80% tier-agreement.
- Specific examination of Tier C false-positive cases (Celebratix, Indicio, Warden) as calibration.

### 11.4 Feedback loops

- **During Phase 1:** reviewer annotations drive enrichment-improvement backlog. Tight loop, days-scale.
- **After Phase 1 exits:** fingerprint may be updated based on patterns observed. New Tier A acquisitions are added to the fingerprint-training set over time.
- **Every 3-6 months (post-Phase 2):** revisit the fingerprint wholesale. Review downgrade-reason distributions. Ad-hoc: when outreach succeeds, trace back through pipeline logs to confirm the match made sense.

---

## 12. Out of Scope (Explicit Non-Goals)

- **Crunchbase programmatic scraping.** Not ToS-legitimate. Used only via human review.
- **LinkedIn scraping for discovery.** Not ToS-legitimate. LinkedIn reserved for outreach.
- **Automated tier-final decisions.** Human review is a Phase 1 feature (the point) and will remain so even in Phase 2 where Module B's role is proposal, not final decision.
- **Module B / Scoring Agent in Phase 1.** Explicitly deferred until Phase 1 DoD is met.
- **Cold LLM-only scoring.** Even in Phase 2, LLM extraction is a conditional second pass, not the primary scoring mechanism.
- **Real-time outreach triggering.** Outreach is a separate system; this pipeline's output is a queue, not an action trigger.
- **Multi-language content processing.** English only.
- **Multi-reviewer workflows / web UI.** CLI-first, solo-me in Phase 1; Git PR-flow when collaboration starts.
- **Serving FinScout's existing `/v1/discovery/evaluate` API.** That endpoint is currently served by legacy `src/services/discoveryEngine.ts`. Re-wiring to the new pipeline is a separate migration.
- **Automated LinkedIn enrichment.** Intentionally deferred. A future enhancement may integrate a ToS-shifted service (e.g., Anysite, Wiza) to automate enrichment during review, but only after v1 pipeline is running and manual LinkedIn-review is measured as a real bottleneck.

---

## 13. Relationship to Existing FinScout Architecture

Module layout:

```
finscout-ai-agents/
├── src/
│   ├── sales-factory/                # EXISTING — iDECP, unchanged
│   ├── discovery/                    # EXISTING — XDiscoverySource
│   │                                 #   (retroactive spec pending)
│   ├── enrichment/                   # NEW — Module A
│   │   ├── EnrichmentEngine.ts
│   │   ├── ProfileComposer.ts
│   │   ├── website/
│   │   │   ├── WebsiteEnricher.ts
│   │   │   ├── extractors/           # architecture, team, funding, product
│   │   │   └── sources/
│   │   │       ├── PageFetcher.ts       # interface
│   │   │       ├── FirecrawlFetcher.ts  # v1 impl
│   │   │       └── FixturePageFetcher.ts
│   │   ├── x-signal/
│   │   │   ├── XSignalSource.ts
│   │   │   ├── templateMatcher.ts
│   │   │   └── companyResolver.ts
│   │   └── *.test.ts
│   ├── fingerprint/                  # NEW — Fingerprint authoring + runtime
│   │   ├── FingerprintLoader.ts
│   │   ├── FingerprintAuthor.ts
│   │   ├── vocabularyExtractor.ts    # AI-assisted suggestion
│   │   ├── cli/
│   │   │   ├── suggest.ts
│   │   │   ├── review.ts
│   │   │   ├── compile.ts
│   │   │   └── validate.ts
│   │   └── *.test.ts
│   ├── review-queue/                 # NEW — Phase 1 review workflow
│   │   ├── ReviewQueue.ts
│   │   ├── persistence.ts
│   │   ├── cli/
│   │   │   ├── next.ts
│   │   │   ├── stats.ts
│   │   │   └── export.ts
│   │   └── *.test.ts
│   ├── schema/
│   │   ├── lead.schema.ts            # EXISTING
│   │   ├── enrichedProfile.ts        # NEW — THE contract
│   │   ├── reviewAnnotation.ts       # NEW
│   │   ├── fingerprint.ts            # NEW
│   │   └── ...
│   └── services/                     # LEGACY — untouched this phase
├── specs/
│   ├── sales-factory/                # EXISTING
│   ├── discovery/                    # NEW — retroactive for XDiscoverySource
│   ├── enriched-profile/             # NEW — the contract
│   ├── fingerprint/                  # NEW
│   ├── enrichment-engine/            # NEW — Module A orchestrator
│   ├── x-signal-source/              # NEW — X sub-module
│   └── review-queue/                 # NEW — Phase 1 DoD
└── data/
    ├── icp-reference.json            # 65-company dataset + reference clients
    ├── fingerprints/                 # Core + per-cell (versioned)
    ├── review-queue.db               # SQLite (Phase 1 state)
    └── fixtures/
        ├── pages/                    # Captured page fixtures for tests
        └── tweets/                   # Captured tweet fixtures for tests
```

### 13.1 Retroactive spec for `XDiscoverySource` (unchanged from v0.1)

The existing `XDiscoverySource.ts` has 18 passing tests but no spec. Before Module A is built, write `specs/discovery/spec.md` retroactively to bring the existing module under the iDECP protocol umbrella. This closes the protocol-compliance gap and establishes the conventions the new specs will follow. This is a separate agent prompt (not the v0.2 doc land).

### 13.2 Legacy/iDECP fork (unchanged from v0.1)

The pipeline builds on the iDECP side and does not attempt to re-wire the existing Express endpoints. Accept the "built but not wired" surface during Phase 1/2; migration of `/v1/discovery/evaluate` is a separate future effort.

---

## 14. Sequencing and Dependencies (Phase 1)

Phase 1 specs are written and implemented in this order:

1. **`specs/discovery/spec.md`** (retroactive, for existing `XDiscoverySource`). Closes protocol gap.
2. **`specs/enriched-profile/spec.md`** — the contract. No dependencies. Everything else depends on it.
3. **`specs/fingerprint/spec.md`** — authoring workflow + runtime resolution. Depends on matrix (§3) definition.
4. **`specs/x-signal-source/spec.md`** — depends on enriched-profile + fingerprint.
5. **`specs/enrichment-engine/spec.md`** — Module A orchestrator + website enrichment. Depends on x-signal-source + fingerprint + enriched-profile.
6. **`specs/review-queue/spec.md`** — Phase 1 DoD measurement. Depends on enriched-profile.

The retroactive XDiscoverySource spec is the smallest first move (agent prompt already scoped). After that, `enriched-profile` is the highest-leverage spec to write next — it's the contract, and writing it forces all remaining design decisions to surface.

---

## 15. Open Questions (For Review)

Reduced from v0.1's ten items after most resolved in v0.2 drafting:

1. **Cluster 1/2/3 ↔ Competency Matrix relationship** (§3.1): still flagged as [ASSUMPTION] — confirm orthogonality or correct.
2. **Deployment model** (§2): Docker Compose matching existing FinScout pattern — confirm.
3. **Persistence layer for review queue** (§8.3): SQLite acceptable, or is there a reason to prefer Postgres or another store?
4. **X API tier**: "Basic" ($100/mo) sufficient for Phase 1 volumes, or does Web3 volume warrant Pro? Re-examine after 1 week of live running.
5. **Reviewer identity persistence**: the `reviewedBy` field — just `"dmitriy"` for Phase 1 as you said, but is there a convention for this already in the codebase?
6. **Fixture corpus commit policy**: capturing live-run page outputs as test fixtures is valuable for regression, but may include captured-tweet content with author handles. Any PII/ToS considerations before committing these?

---

## 16. Success Criteria

This architecture document v0.2 is a success if:

- The five Phase 1 specs listed in §14 can be written without re-opening structural questions.
- An implementer can explain Phase 1 end-to-end from this document alone.
- The Phase 1 DoD (§5.4) is concrete enough to execute and measure.
- Open items (§15) are either resolved in review or explicitly deferred with named owner.

Phase 1 as a whole is a success when:

- Module A is running against live X signal.
- 25-40 EnrichedProfiles have been reviewed.
- ≥80% adequacy rate achieved.
- No single `MissingEvidenceType` dominates >40% of failures.
- Lead-time over Crunchbase measured (secondary, informational).
- The reviewer (you) has concrete, data-driven intuition about the shape of the data Module B will consume.

Only then does Phase 2 begin.

---

*End of discovery-architecture.md v0.2*
