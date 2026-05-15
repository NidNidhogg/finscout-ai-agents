# FinScout — Engineering Roadmap

---

## Phase 1 — Module A: Discovery & Enrichment

**Status: COMPLETE — frozen 2026-05-15**

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
| Enrichment pass | `enrich-pending.ts` — Firecrawl deep-crawl on pending queue, stack + arch signal merge, circuit breaker (no technical signals → `discarded`), auto `ReviewAnnotation` |
| Outreach generation | `generate-outreach.ts` — Gemini 2.0 Flash, Baron Sever persona, 4-sentence framework (Hook → Hypothesis → Value Drop → CTA), writes `data/exports/outreach-drafts-*.md`, second circuit breaker pre-LLM |

### Known Gaps (Backlog — not blocking Phase 2)

| Gap | Detail |
|---|---|
| PDF extraction | Sites like Americanfort embed SDK docs as PDFs. Firecrawl returns a viewer shell. HTML signals from `/sdk` page are sufficient for Phase 1 emails. Full PDF pipeline deferred. |
| LinkedIn enrichment | Founder LinkedIn URL is in the schema but not populated. Manual addition only. |
| Crunchbase auto-verification | `confirmed.foundInCrunchbase` requires manual Crunchbase check in the review step. Automated cross-reference deferred. |
| Headcount extraction | `team.estimatedHeadcount` schema exists but enricher does not populate it. Requires LLM parsing of `/about` or `/careers` pages. |

---

## Phase 2 — Outreach Automation & Signal Expansion

**Status: PLANNED**

### LinkedIn / Email Sender Integration (HITL)

Integrate a mail sender adapter (SendGrid or Resend) behind a `MailSender` interface. Human-in-the-loop gate: operator reviews and approves drafts before any send action is triggered.

- `MailSender` interface: `send(draft): Promise<void>` — injected; no-op stub in current soft launch
- `ConcreteMailSender`: SendGrid or Resend REST adapter
- `send-outreach.ts` CLI: reads `drafted` queue items, sends via `MailSender`, transitions to `sent`
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
