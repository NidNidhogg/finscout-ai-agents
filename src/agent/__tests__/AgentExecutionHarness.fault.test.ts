/**
 * Fault-tolerance integration tests for AgentExecutionHarness.
 * Uses in-memory SQLite and jest mocks for all external I/O.
 *
 * Scenarios:
 *   1. Tool Failure Isolation  — FirecrawlFetcher.fetch throws; loop continues via Promise.allSettled
 *   2. Hard Crash Rollback     — fatal LLM error on iter 2; queue rolls back to 'reviewed'
 *   3. Stale Run Resumption    — 20-min-old 'running' row resumed from persisted history checkpoint
 */

import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { FirecrawlFetcher } from '../../enrichment/website/FirecrawlFetcher';
import { ConcreteXApiClient } from '../../enrichment/x-signal/ConcreteXApiClient';
import { AgentExecutionHarness, NO_SIGNALS_SENTINEL } from '../AgentExecutionHarness';

// ── Module mocks ───────────────────────────────────────────────────────────────

jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn(),
  SchemaType: {
    OBJECT: 'OBJECT',
    STRING: 'STRING',
    INTEGER: 'INTEGER',
    NUMBER: 'NUMBER',
    BOOLEAN: 'BOOLEAN',
    ARRAY: 'ARRAY',
  },
}));
jest.mock('../../enrichment/website/FirecrawlFetcher');
jest.mock('../../enrichment/x-signal/ConcreteXApiClient');

// ── Fixtures ───────────────────────────────────────────────────────────────────

const PROFILE_JSON = JSON.stringify({
  id: randomUUID(),
  enrichedAt: '2026-01-01T00:00:00.000Z',
  schemaVersion: '1.0.0',
  sources: {},
  company: {
    name: 'TestCo',
    normalizedName: 'testco',
    websiteUrl: 'https://example.com',
    xHandle: '@testco',
  },
  funding: {
    claimed: {
      rawText: 'X-Radar: @testco just announced raising $5M in Seed.',
      amountUSD: 5_000_000,
      stage: 'seed',
    },
  },
  product: {
    stackMentions: [],
    architectureTerms: [],
    antiSignalTerms: [],
    competencyCellMatches: [],
    evidence: [],
  },
  team: { founders: [] },
  rawContent: { websiteMarkdown: {}, sourceTweets: [] },
});

const RUN_CONTEXT = {
  sourceAngle: 'X Funding Radar — MVA / post-raise',
  hypothesis: 'Name a precise architectural risk implied by their stack.',
  valueDrop: 'One sentence on how iDECP eliminates this.',
};

const EMAIL_DRAFT =
  'SUBJECT: defi vault async bottlenecks\n\n' +
  'Hey Alex,\n\n' +
  'Saw you just closed a Seed round and are running vault liquidations synchronously. ' +
  'The risk is a cascading settlement failure under load. ' +
  "iDECP's MVA engagement eliminates this with async circuit-breaker primitives in weeks 1–4. " +
  'Worth a quick async thread?\n\n' +
  'Baron';

const SCRAPED_PAGE = {
  url: 'https://example.com',
  markdown: '# TestCo\nWe build DeFi protocols on Ethereum.',
  title: 'TestCo',
  metadata: {},
  fetchedAt: new Date().toISOString(),
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE queue_items (
      id              TEXT PRIMARY KEY,
      profile_json    TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending',
      enqueued_at     TEXT NOT NULL,
      reviewed_at     TEXT,
      annotation_json TEXT
    )
  `);
  return db;
}

function insertQueueItem(
  db: Database.Database,
  profileJson: string,
  status = 'reviewed',
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO queue_items (id, profile_json, status, enqueued_at) VALUES (?, ?, ?, ?)`,
  ).run(id, profileJson, status, new Date().toISOString());
  return id;
}

function makeTextResponse(text: string) {
  const content = { role: 'model', parts: [{ text }] };
  return {
    response: {
      candidates: [{ content }],
      functionCalls: () => undefined,
      text: () => text,
    },
  };
}

function makeFunctionCallResponse(name: string, args: object) {
  const content = { role: 'model', parts: [{ functionCall: { name, args } }] };
  return {
    response: {
      candidates: [{ content }],
      functionCalls: () => [{ name, args }],
      text: (): never => {
        throw new Error('functionCalls response has no text');
      },
    },
  };
}

function makeHarness(db: Database.Database): AgentExecutionHarness {
  return new AgentExecutionHarness({
    db,
    geminiApiKey: 'test-key',
    firecrawlApiKey: 'fc-test-key',
    xBearerToken: 'x-test-token',
    model: 'gemini-test',
    maxIterations: 4,
    maxToolRepeats: 2,
  });
}

// ── Mock wiring ────────────────────────────────────────────────────────────────

const MockGoogleGenerativeAI = GoogleGenerativeAI as jest.MockedClass<typeof GoogleGenerativeAI>;
const MockFirecrawlFetcher = FirecrawlFetcher as jest.MockedClass<typeof FirecrawlFetcher>;
const MockConcreteXApiClient = ConcreteXApiClient as jest.MockedClass<typeof ConcreteXApiClient>;

let mockGenerateContent: jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockGenerateContent = jest.fn();
  MockGoogleGenerativeAI.mockImplementation(
    () =>
      ({
        getGenerativeModel: jest.fn().mockReturnValue({ generateContent: mockGenerateContent }),
      }) as never,
  );
  MockFirecrawlFetcher.prototype.fetch = jest.fn();
  MockConcreteXApiClient.prototype.searchRecentTweets = jest.fn().mockResolvedValue([]);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AgentExecutionHarness fault tolerance', () => {
  describe('Test 1: Tool Failure Isolation (Promise.allSettled resilience)', () => {
    it('continues the loop and produces a draft when crawl_website throws', async () => {
      const db = createTestDb();
      const queueItemId = insertQueueItem(db, PROFILE_JSON);

      // FirecrawlFetcher.fetch throws — dispatchTool must absorb this and return { error }
      (MockFirecrawlFetcher.prototype.fetch as jest.Mock).mockRejectedValue(
        new Error('Website enrichment failed for: https://example.com'),
      );

      // Iter 1: LLM requests a crawl. Iter 2: LLM adapts to the error and produces the draft.
      mockGenerateContent
        .mockResolvedValueOnce(
          makeFunctionCallResponse('crawl_website', { url: 'https://example.com' }),
        )
        .mockResolvedValueOnce(makeTextResponse(EMAIL_DRAFT));

      const harness = makeHarness(db);
      const record = await harness.run(queueItemId, RUN_CONTEXT);

      // Loop must complete without throwing
      expect(record.status).toBe('completed');
      expect(record.draftBody).not.toBe(NO_SIGNALS_SENTINEL);
      expect(record.draftBody).toContain('Baron');

      // Queue item must advance to 'drafted'
      const qi = db
        .prepare<[string], { status: string }>('SELECT status FROM queue_items WHERE id = ?')
        .get(queueItemId)!;
      expect(qi.status).toBe('drafted');

      // LLM was called twice: once for the tool call, once for the final draft
      expect(mockGenerateContent).toHaveBeenCalledTimes(2);

      // The second LLM call's history must contain the function-response item that encodes the error
      // (history is mutated in-place after the call, so we read the array contents at assertion time)
      const secondCallContents = mockGenerateContent.mock.calls[1]![0].contents as Array<{
        role: string;
        parts: unknown[];
      }>;
      const functionResponseItem = secondCallContents.find((c) => c.role === 'function');
      expect(functionResponseItem).toBeDefined();
      expect(JSON.stringify(functionResponseItem)).toContain('"error"');
    });
  });

  describe('Test 2: Hard Crash Rollback (Transactional Integrity)', () => {
    it('rolls back queue_items to "reviewed" and marks agent_run "failed" on fatal LLM error', async () => {
      const db = createTestDb();
      const queueItemId = insertQueueItem(db, PROFILE_JSON);

      // Iteration 1: tool call succeeds
      (MockFirecrawlFetcher.prototype.fetch as jest.Mock).mockResolvedValue(SCRAPED_PAGE);
      mockGenerateContent
        .mockResolvedValueOnce(
          makeFunctionCallResponse('crawl_website', { url: 'https://example.com' }),
        )
        // Iteration 2: fatal throw before returning candidates
        .mockRejectedValueOnce(new Error('Fatal: Gemini quota exceeded'));

      const harness = makeHarness(db);

      await expect(harness.run(queueItemId, RUN_CONTEXT)).rejects.toThrow(
        'Fatal: Gemini quota exceeded',
      );

      // Queue item must be rolled back to allow human retry
      const qi = db
        .prepare<[string], { status: string }>('SELECT status FROM queue_items WHERE id = ?')
        .get(queueItemId)!;
      expect(qi.status).toBe('reviewed');

      // agent_run must record the failure
      const agentRun = db
        .prepare<
          [string],
          { status: string; error_message: string; history_json: string }
        >(
          'SELECT status, error_message, history_json FROM agent_runs WHERE queue_item_id = ?',
        )
        .get(queueItemId)!;
      expect(agentRun.status).toBe('failed');
      expect(agentRun.error_message).toContain('Fatal: Gemini quota exceeded');

      // History persisted at the start of iteration 2 must be the 3-item checkpoint:
      //   [0] initial user message
      //   [1] model function-call response (from iter 1 generateContent)
      //   [2] function result (tool response, persisted after iter 1 dispatch)
      const history = JSON.parse(agentRun.history_json) as unknown[];
      expect(history).toHaveLength(3);
    });
  });

  describe('Test 3: Stale Run Resumption', () => {
    it('resumes from persisted history checkpoint when a 20-min-old running run is found', async () => {
      const db = createTestDb();
      // Queue item is stuck in 'agent-running' (process died mid-run)
      const queueItemId = insertQueueItem(db, PROFILE_JSON, 'agent-running');

      // Create harness first so ensureSchema() creates agent_runs table
      const harness = makeHarness(db);

      // Insert a stale run row (started 20 min ago, still 'running')
      const runId = randomUUID();
      const staleStartedAt = new Date(Date.now() - 20 * 60 * 1_000).toISOString();
      const savedHistory = [
        {
          role: 'user',
          parts: [{ text: 'Research and draft for the following company (checkpoint test).' }],
        },
        {
          role: 'model',
          parts: [{ functionCall: { name: 'crawl_website', args: { url: 'https://example.com' } } }],
        },
        {
          role: 'function',
          parts: [
            {
              functionResponse: {
                name: 'crawl_website',
                response: {
                  pages: [{ url: 'https://example.com', title: 'TestCo', markdown: '# TestCo' }],
                },
              },
            },
          ],
        },
      ];

      db.prepare(
        `INSERT INTO agent_runs (id, queue_item_id, status, model, started_at, history_json)
         VALUES (?, ?, 'running', ?, ?, ?)`,
      ).run(runId, queueItemId, 'gemini-test', staleStartedAt, JSON.stringify(savedHistory));

      // Capture generateContent's contents BEFORE the loop mutates the history array
      let capturedContents: unknown[] = [];
      mockGenerateContent.mockImplementation(async ({ contents }: { contents: unknown[] }) => {
        capturedContents = JSON.parse(JSON.stringify(contents)) as unknown[];
        return makeTextResponse(EMAIL_DRAFT);
      });

      await harness.resumeIfIncomplete(queueItemId);

      // generateContent called exactly once: the resume iteration (not a fresh start)
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);

      // The call started from the 3-item checkpoint, not an empty or single-item history
      expect(capturedContents).toHaveLength(3);
      expect(capturedContents[0]).toMatchObject({ role: 'user' });
      expect(capturedContents[2]).toMatchObject({ role: 'function' });

      // Queue item advances to 'drafted' after successful resume
      const qi = db
        .prepare<[string], { status: string }>('SELECT status FROM queue_items WHERE id = ?')
        .get(queueItemId)!;
      expect(qi.status).toBe('drafted');

      // The stale agent_run is now completed
      const agentRun = db
        .prepare<[string], { status: string }>('SELECT status FROM agent_runs WHERE id = ?')
        .get(runId)!;
      expect(agentRun.status).toBe('completed');
    });
  });

  describe('Test 4: Budget Breaker Under Repeated Tool Failure', () => {
    it('triggers argument-aware repeat limit and completes via finalizeBudgetExhausted', async () => {
      const db = createTestDb();
      const queueItemId = insertQueueItem(db, PROFILE_JSON);

      // FirecrawlFetcher.fetch always fails — agent can never get a crawl result
      (MockFirecrawlFetcher.prototype.fetch as jest.Mock).mockRejectedValue(
        new Error('Website enrichment failed for: https://example.com'),
      );

      // LLM stubbornly repeats the same crawl call every iteration (same args → same hash key)
      // With maxToolRepeats=2: iter 1 (count=1 ✓), iter 2 (count=2 ✓), iter 3 (count=3 → EXCEEDS 2)
      const sameFunctionCall = makeFunctionCallResponse('crawl_website', { url: 'https://example.com' });
      mockGenerateContent
        .mockResolvedValueOnce(sameFunctionCall)   // iter 1
        .mockResolvedValueOnce(sameFunctionCall)   // iter 2
        .mockResolvedValueOnce(sameFunctionCall)   // iter 3 → triggers repeat limit (count=3 > 2)
        .mockResolvedValueOnce(makeTextResponse(EMAIL_DRAFT)); // finalizeBudgetExhausted final call

      const harness = makeHarness(db);
      const record = await harness.run(queueItemId, RUN_CONTEXT);

      // Run must complete (not throw) via the budget-exhausted path
      expect(record.status).toBe('budget_exhausted');
      expect(record.draftBody).toContain('Baron');

      // generateContent called 4 times: 3 repeat iterations + 1 finalizeBudgetExhausted call
      expect(mockGenerateContent).toHaveBeenCalledTimes(4);

      // dispatchTool was only reached for iterations 1 and 2 (iter 3 was blocked by repeat check)
      expect(MockFirecrawlFetcher.prototype.fetch).toHaveBeenCalledTimes(2);

      // Queue item advances to 'drafted' (finalizeBudgetExhausted produced a real draft)
      const qi = db
        .prepare<[string], { status: string }>('SELECT status FROM queue_items WHERE id = ?')
        .get(queueItemId)!;
      expect(qi.status).toBe('drafted');

      // agent_run history must contain the synthetic "Repeat-call limit" message injected by finalizeBudgetExhausted
      const agentRun = db
        .prepare<[string], { history_json: string }>(
          'SELECT history_json FROM agent_runs WHERE queue_item_id = ?',
        )
        .get(queueItemId)!;
      const history = JSON.parse(agentRun.history_json) as Array<{ role: string; parts: unknown[] }>;
      const budgetPrompt = history.find(
        (c) =>
          c.role === 'user' &&
          JSON.stringify(c.parts).toLowerCase().includes('repeat-call limit'),
      );
      expect(budgetPrompt).toBeDefined();
    });
  });

  describe('Test 5: Malformed Tool-Call Arguments (Zod Resilience)', () => {
    it('wraps Zod validation failure into a function-response error and continues the loop', async () => {
      const db = createTestDb();
      const queueItemId = insertQueueItem(db, PROFILE_JSON);

      // LLM passes url as a number — fails CrawlWebsiteInputSchema.parse (url must be a string URL)
      mockGenerateContent
        .mockResolvedValueOnce(makeFunctionCallResponse('crawl_website', { url: 12345 }))
        .mockResolvedValueOnce(makeTextResponse(EMAIL_DRAFT));

      const harness = makeHarness(db);

      // Must NOT throw — Zod error must be absorbed by Promise.allSettled in executeLoop
      const record = await harness.run(queueItemId, RUN_CONTEXT);

      expect(record.status).toBe('completed');
      expect(record.draftBody).toContain('Baron');

      // firecrawl.fetch must NEVER be called — Zod intercepted before the fetch attempt
      expect(MockFirecrawlFetcher.prototype.fetch).not.toHaveBeenCalled();

      // LLM was called twice: once for the bad tool call, once for the final draft
      expect(mockGenerateContent).toHaveBeenCalledTimes(2);

      // The second LLM call's history must contain the function-response encoding the Zod error
      const secondCallContents = mockGenerateContent.mock.calls[1]![0].contents as Array<{
        role: string;
        parts: unknown[];
      }>;
      const functionResponseItem = secondCallContents.find((c) => c.role === 'function');
      expect(functionResponseItem).toBeDefined();
      // Zod error message is propagated as { error: '...' } in the response
      expect(JSON.stringify(functionResponseItem)).toContain('"error"');
    });
  });
});
