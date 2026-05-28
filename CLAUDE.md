# CLAUDE.md — finscout-ai-agents
# Inherits: ~/.claude/CLAUDE.md (iDECP Global Orchestrator Protocol)

## Execution Environment

- Language:        TypeScript 5.x
- Runtime:         Node.js 20
- Package Manager: npm

## Testing Conventions

- Framework:       Jest
- Test location:   src/**/*.test.ts
- Run all:         npm run test
- Run single file: npx jest src/path/to/file.test.ts
- Run single test: npx jest -t "test name"
- Coverage:        npm run test -- --coverage
- Fixture conventions: Jest beforeEach/afterEach; mock external I/O at module boundaries

## Quality Gate Chain

1. npm run lint
2. npm run test
3. npm run build

## Directory Structure

- Source root:     src/
- Test root:       src/**/*.test.ts
- Configuration:   src/config/
- Generated code:  dist/ (do not manually edit)

## Stack-Specific Rules

- Use Zod for ALL input validation and schema definitions — no raw type assertions at system boundaries.
- No `any` type outside of test files.
- All async functions must have explicit return types.

## Anti-Hallucination Policy

- NEVER invent or guess X/Twitter handles from company names, domains, or any other heuristic.
- If a verified handle is not returned by the enrichment pipeline, `xHandle` MUST be `null`. No exceptions.
- Fall back to the verified `websiteUrl` domain for all outreach targeting when a handle is absent.
- This rule is invariant and overrides any instruction requesting a "best guess" or "probable" handle.
- CeFi/CeDeFi companies lacking on-chain TVL data (e.g., neobanks not indexed by DeFiLlama) MUST be seeded with a hardcoded verified `websiteUrl` in the seeder dictionary (`src/cli/seed-neobanks.ts`). If no URL can be verified from authoritative sources, omit the key entirely — do not guess. Bare-name entries without a `websiteUrl` are discarded by `enrich-pending.ts`; this is the correct outcome, not a bug.

## Pipeline State Machine

Valid `queue_items.status` values (TypeScript: `QueueItemStatus` in `src/review-queue/types.ts`):

| Status | Owner | Meaning |
|--------|-------|---------|
| `pending` | `fetch-funding.ts`, `fetch-defillama.ts`, `inject-*.ts` | Awaiting enrichment |
| `needs_retry` | `enrich-pending.ts` | Soft fail — crawl error + no signals; re-selected next run |
| `reviewed` | `enrich-pending.ts`, `AgentExecutionHarness` | Enriched + scored Tier A/B; awaiting draft |
| `drafted` | `generate-outreach.ts`, `AgentExecutionHarness` | Draft written; awaiting HITL approval |
| `sent` | `review-outreach.ts` | Approved and sent via `IMailSender` |
| `discarded` | `enrich-pending.ts`, `generate-outreach.ts`, `review-outreach.ts` | Hard fail or human rejection |
| `dropped` | `ReviewQueue.drop()` | Programmatic drop (ReviewQueue API) |
| `agent-running` | `AgentExecutionHarness` | Agent loop in progress |

**Soft-fail rule:** Network/API errors (Firecrawl timeout, 429, scraping block) → `needs_retry`. Logical misses (Tier C, no signals after successful crawl) → `discarded`. Never route a transient error to `discarded`.

## Orchestrator

`npm run scout` is the headless orchestrator — safe for unattended and cron execution. It chains five stages with `&&` and issues no interactive prompts:
```
fetch-defillama.ts && fetch-funding.ts && enrich-pending.ts && generate-outreach.ts && npm run export
```
MVA constraint: this `&&` chain in `package.json` is the only orchestrator. No message brokers, no workers, no schedulers.

`npm run review` is the separate manual step for HITL approval of drafted outreach:
```
ts-node src/cli/review-outreach.ts
```
Run `npm run review` in an interactive terminal after `npm run scout` completes. The two commands are intentionally decoupled — `scout` never blocks on CLI input.

## MCP Context Modules Active

<!-- Which modules are registered for this project. -->
<!-- - <module-name>: mcp/<path>/ (reads: <what it exposes>) -->
