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

### Known Gaps (Backlog — not blocking Phase 2)

| Gap | Detail |
|---|---|
| PDF extraction | Sites like Americanfort embed SDK docs as PDFs. Firecrawl returns a viewer shell. HTML signals from `/sdk` page are sufficient for Phase 1 emails. Full PDF pipeline deferred. |
| LinkedIn enrichment | Founder LinkedIn URL is in the schema but not populated. Manual addition only. |
| Crunchbase auto-verification | `confirmed.foundInCrunchbase` requires manual Crunchbase check in the review step. Automated cross-reference deferred. |
| Headcount extraction | `team.estimatedHeadcount` schema exists but enricher does not populate it. Requires LLM parsing of `/about` or `/careers` pages. |

---

## Phase 2 — Module C: Outreach Engine

**Status: NOT STARTED**

### Scope

Module C consumes the `data/exports/reviewed-YYYY-MM-DD.json` output from Module A and automates the generation and delivery of personalised cold outreach emails.

### Design Constraints

- **Input:** Only Tier A profiles from `review-export`. Tier B/C are not emailed in soft launch.
- **Personalisation surface:** `product.architectureTerms`, `product.stackMentions`, `product.competencyCellMatches`, `funding.claimed.rawText`, `team.openRoles`.
- **Signal-to-email mapping:** Each competency cell has a corresponding outreach angle. A profile with `matchedCells: [Security]` and `architectureTerms: [hsm, threshold signature]` should trigger a zero-trust / key management angle, not a generic DeFi pitch.
- **Anthropic API:** Use Claude for email drafting. Model: `claude-opus-4-7` (highest quality) or `claude-sonnet-4-6` (cost/quality balance). No streaming required — batch generation.

### Delivery: Soft Launch vs Hard Launch

**Soft Launch (recommended first)**

Generate emails and write them to a local JSON file (`data/drafts/outreach-YYYY-MM-DD.json`). No sending. Founder reviews each draft, edits as needed, sends manually. Validates template quality before any automation touches the outbox.

```
review-export.ts  →  draft-emails.ts  →  data/drafts/  →  manual send
```

**Hard Launch**

Integrate a mail sender (SendGrid, Resend, or SMTP) as a concrete adapter behind a `MailSender` interface. Send rate-limited (≤ 20/day in MVP). Unsubscribe token embedded in each email. Bounce/reply tracking via webhook.

```
review-export.ts  →  draft-emails.ts  →  MailSender  →  SMTP/API  →  inbox
```

Hard launch is gated on Soft Launch validation: ≥ 10 manually-sent emails with acceptable reply rate before automation is switched on.

### Proposed Module C Components

| Component | Responsibility |
|---|---|
| `OutreachProfileSchema` (Zod) | Validated input contract from `review-export.ts` output |
| `EmailDrafter` interface | `draft(profile): Promise<EmailDraft>` |
| `ClaudeEmailDrafter` | Concrete implementation — builds structured prompt from profile signals, calls Anthropic API |
| `CellTemplateRegistry` | Maps `CompetencyCell` → system prompt context + subject line heuristics |
| `MailSender` interface | `send(draft): Promise<void>` — injected; stub in Soft Launch |
| `ConcreteMailSender` | Concrete implementation (SendGrid or Resend REST adapter) — Hard Launch only |
| `draft-emails.ts` CLI | Reads export JSON, drafts emails, writes to `data/drafts/` |
| `send-outreach.ts` CLI | Reads drafts, sends via `MailSender`, records sent status in SQLite |

### Acceptance Criteria (Soft Launch)

1. `draft-emails.ts` produces one `EmailDraft` per Tier A profile with non-empty `subject` and `body`.
2. Draft `body` references at least one signal extracted from the profile (`architectureTerms` or `stackMentions`).
3. No email is generated for a profile that has already been drafted (idempotency by `profile.id`).
4. Draft JSON is valid per `EmailDraftSchema` (Zod).
5. CLI exits cleanly when the export file is empty.

---

## Phase 3 — Module B: Signal Intelligence (Future)

**Status: DESIGN — post-Phase 2**

Enrichment signals beyond the current vocabulary scan:

- **GitHub activity** — commit frequency, open issues, recent hires visible in contributor graph
- **LinkedIn headcount delta** — month-over-month employee count change as a hiring velocity signal
- **Crunchbase auto-sync** — automated funding confirmation to populate `funding.confirmed`
- **On-chain signal** — TVL delta, transaction volume, contract deployment activity (The Graph or Dune)

None of these are blocked on Phase 2. They are deferred because the Phase 1 signal surface (X + Firecrawl) is sufficient to fill a 10–20 email/week outbound queue at the current stage.
