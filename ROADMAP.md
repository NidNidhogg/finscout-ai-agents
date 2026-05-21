# FinScout — Engineering Roadmap

---

## Phase 1 — Module A + Module C: Discovery, Enrichment & Outreach

**Status: COMPLETE — operational 2026-05-21**

### Delivered

| Capability | Implementation |
|---|---|
| X API v2 tweet ingestion | `ConcreteXApiClient` — `GET /2/tweets/search/recent`, 100 results/call |
| Profile URL extraction | `user.entities.url.urls[0].expanded_url` — bypasses t.co short links |
| 5-stage filter chain | Template match → anti-vocab → signal density → funding threshold ($1M floor) → company resolver |
| Tiered enrichment | URL-present: full Firecrawl crawl. URL-absent: lite profile (X data only). No candidates discarded for missing URL. |
| Two-phase deep crawl | Phase 1: `includePaths: [doc, sdk, developer, api, wiki]` + `excludePaths: [.pdf, whitepaper]`. Phase 2: unrestricted fallback when Phase 1 yields ≤ 1 page. |
| Async Firecrawl polling | `POST /v1/crawl` → `GET /v1/crawl/{id}`, up to 30 poll attempts, configurable interval |
| Signal extraction | Vocabulary scan across all crawled pages: 34 architecture terms, 17 stack mentions |
| Competency cell matching | 5 cells (DeFi & Yield, Trading, Infrastructure, Security, Payment Rails); per-cell score = matched/total |
| EnrichedProfile schema | Zod v4, `schemaVersion: "1.0.0"`, UUID primary key, funding/product/team/rawContent sections |
| ReviewQueue | SQLite state machine (`pending → reviewed | dropped`), `INSERT OR IGNORE`, Zod-validated JSON columns |
| Interactive review CLI | `review-next.ts` — tier assignment, adequacy flag, missing evidence types, Crunchbase check |
| DoD gate | ≥ 25 reviewed, ≥ 80% adequacy rate, no dominant failure mode > 40% |
| Idempotency | 3-layer guard: candidate dedup, in-memory URL Set, cross-run `websiteCrawl.lastFetched` check |
| Export | `review-export.ts` → flat JSON array, input to Module C |
| DefiLlama ingestion | `fetch-defillama.ts` — ICP-filtered TVL $10M–$100M, URL normalizer (redirect resolver + dead-URL discard), cross-run dedup by `websiteUrl`, no API key required |
| Enrichment pass | `enrich-pending.ts` — Firecrawl deep-crawl on `pending` + `needs_retry` queue items, stack + arch signal merge, two-path circuit breaker: crawl error + no signals → `needs_retry` (soft fail); no signals after successful crawl → `discarded` (hard fail); Tier C → `discarded`; auto `ReviewAnnotation` for Tier A/B |
| Outreach generation | `generate-outreach.ts` — Gemini 2.0 Flash, Baron Sever persona, 4-sentence framework (Hook → Hypothesis → Value Drop → CTA), writes `data/exports/outreach-drafts-*.md`, second circuit breaker pre-LLM |
| HITL review CLI | `review-outreach.ts` — interactive approval queue; Tier A → B → C sort + freshest-first within tier; Approve/Edit/Discard/Skip; VS Code (`--wait`) editor with nano fallback; `MockMailSender` transitions to `sent` |
| MailSender abstraction | `IMailSender` interface + `MockMailSender` in `src/services/mail-sender.ts`; `EmailDraft` canonical type; decouples send logic from HITL CLI |
| Pipeline orchestrator | `npm run scout` — `fetch-funding.ts && enrich-pending.ts && generate-outreach.ts && review-outreach.ts`; `&&` chain halts on any non-zero exit; MVA constraint: no message broker |
| Queue dashboard | `queue-dashboard.ts` — ANSI-coloured ASCII table, all statuses, tier distribution, active/inactive split |
| Discard audit | `audit-discards.ts` (`npm run audit-discards`) — groups discards by rejection category with bar chart; surfaces 5 most recent for false-negative spot-checking |
| needs_retry state | Quarantine status for transient failures; `QueueItemStatus` union updated; `enrich-pending.ts` re-selects these items; `annotation_json` stores error reason for audit |
| X-Radar ingestion | `fetch-funding.ts` — Web3/DeFi funding signal ingestion from X API v2; first-person + VC bypass rules; `TRUSTED_CRYPTO_VCS` allowlist (~70 entries); Linktree/aggregator URL unpacking; $1M floor |

### Known Gaps (Backlog — not blocking Phase 2)

| Gap | Detail |
|---|---|
| PDF extraction | Sites like Americanfort embed SDK docs as PDFs. Firecrawl returns a viewer shell. HTML signals from `/sdk` page are sufficient for Phase 1 emails. Full PDF pipeline deferred. |
| LinkedIn enrichment | Founder LinkedIn URL is in the schema but not populated. Manual addition only. |
| Crunchbase auto-verification | `confirmed.foundInCrunchbase` requires manual Crunchbase check in the review step. Automated cross-reference deferred. |
| Headcount extraction | `team.estimatedHeadcount` schema exists but enricher does not populate it. Requires LLM parsing of `/about` or `/careers` pages. |

---

## Phase 2 — Outreach Automation & Signal Expansion

**Status: IN PROGRESS**

### Real Email Sender Integration

`IMailSender` interface and `MockMailSender` are already implemented (`src/services/mail-sender.ts`). The HITL CLI (`review-outreach.ts`) already uses `MockMailSender` and transitions approved items to `sent`. What remains is the concrete adapter.

- `ConcreteMailSender`: SendGrid or Resend REST adapter implementing `IMailSender` — drop-in replacement for `MockMailSender`
- Rate-limited: ≤ 20 emails/day in MVP
- Unsubscribe token embedded per email; honoured immediately on click
- Bounce and reply tracking via provider webhook → updates queue status

### Automated Reply Sentiment Analysis

Parse inbound reply threads via IMAP or provider webhook. Classify each reply and update queue state.

| Sentiment | Queue status transition | Action |
|---|---|---|
| Interested / positive | `sent → replied-positive` | Surface for founder follow-up within 24h |
| Neutral / no-right-now | `sent → replied-neutral` | Log; no immediate action |
| Unsubscribe | `sent → unsubscribed` | Suppression list; never contact again |

Classification model: Gemini 2.0 Flash with a short system prompt (no fine-tuning required at this volume).

### Multi-Source Signals

Extend `EnrichedProfile` with signals from two additional sources, feeding into `team.openRoles` and `product.evidence`.

**GitHub activity (`src/enrichment/github/`)**
- Public commit frequency and contributor count as engineering velocity proxy
- Open issues labelled `help wanted` or `good first issue` as hiring signal
- No GitHub token required for public repos at this volume

**Job board scraping (`src/enrichment/jobs/`)**
- Greenhouse, Lever, and Ashby job pages via Firecrawl targeted crawl
- Open engineering roles extracted into `team.openRoles[].title` and `stackHints`
- LinkedIn headcount delta deferred (requires authenticated session or third-party API)

---

## Phase 3 — Module B: Signal Intelligence (Future)

**Status: DESIGN — post-Phase 2**

Enrichment signals beyond the current vocabulary scan:

- **GitHub activity** — commit frequency, open issues, recent hires visible in contributor graph
- **LinkedIn headcount delta** — month-over-month employee count change as a hiring velocity signal
- **Crunchbase auto-sync** — automated funding confirmation to populate `funding.confirmed`
- **On-chain signal** — TVL delta, transaction volume, contract deployment activity (The Graph or Dune)

None of these are blocked on Phase 2. They are deferred because the Phase 1 signal surface (X + Firecrawl) is sufficient to fill a 10–20 email/week outbound queue at the current stage.
