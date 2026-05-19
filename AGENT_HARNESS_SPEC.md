# Agent Harness Spec — AgentExecutionHarness v1.0
# [spec:agent-harness/v1.0] [executor:claude]

## DDL

```sql
CREATE TABLE IF NOT EXISTS agent_runs (
  id              TEXT PRIMARY KEY,      -- UUID per run attempt
  queue_item_id   TEXT NOT NULL,         -- FK → queue_items.id; no UNIQUE — retries allowed
  status          TEXT NOT NULL DEFAULT 'running',
                  -- 'running' | 'completed' | 'failed' | 'budget_exhausted'
  model           TEXT NOT NULL,
  started_at      TEXT NOT NULL,         -- ISO 8601
  completed_at    TEXT,                  -- ISO 8601; NULL while running
  iteration_count INTEGER NOT NULL DEFAULT 0,
  history_json    TEXT NOT NULL DEFAULT '[]', -- JSON Content[]
  draft_subject   TEXT,                  -- NULL until completed
  draft_body      TEXT,                  -- 'NO_SIGNALS_FOUND' triggers discarded status
  error_message   TEXT,
  FOREIGN KEY (queue_item_id) REFERENCES queue_items(id)
);
```

`queue_items.status` lifecycle extended:
```
pending → reviewed → agent-running → drafted
                                   → discarded   (draft_body = 'NO_SIGNALS_FOUND')
                   → reviewed       (on harness error — rollback for retry)
```

---

## TypeScript Types

```typescript
export type AgentRunStatus = 'running' | 'completed' | 'failed' | 'budget_exhausted';

export interface AgentRunRecord {
  id: string;
  queueItemId: string;
  status: AgentRunStatus;
  model: string;
  startedAt: string;
  completedAt: string | null;
  iterationCount: number;
  draftSubject: string | null;
  draftBody: string | null;  // 'NO_SIGNALS_FOUND' is a sentinel, not an error
  errorMessage: string | null;
}

export interface RunContext {
  sourceAngle: string;    // e.g. "X Funding Radar — MVA / post-raise..."
  hypothesis: string;     // source-specific hypothesis framing for the email
  valueDrop: string;      // source-specific value drop framing
}

export interface AgentHarnessConfig {
  db: Database.Database;
  geminiApiKey: string;
  firecrawlApiKey: string;
  xBearerToken: string;
  model?: string;         // default: 'gemini-2.0-flash'
  maxIterations?: number; // default: 8
  maxToolRepeats?: number;// default: 2 (argument-aware); name-only backstop at 5
}
```

---

## Zod I/O Schemas

```typescript
// crawl_website
const CrawlWebsiteInputSchema = z.object({
  url: z.string().url(),
});

// search_x_tweets
const SearchXTweetsInputSchema = z.object({
  query: z.string().min(1).max(512),
  maxResults: z.number().int().min(5).max(10).default(10),
});
```

---

## Gemini FunctionDeclaration Schemas

SDK: `@google/generative-ai@^0.21.0`
Enum: `SchemaType` (not `FunctionDeclarationSchemaType` — not exported in 0.21)
Property interface: `FunctionDeclarationSchemaProperty extends Schema`

```typescript
import { SchemaType } from '@google/generative-ai';
import type { FunctionDeclarationsTool } from '@google/generative-ai';

const HARNESS_TOOLS: FunctionDeclarationsTool = {
  functionDeclarations: [
    {
      name: 'crawl_website',
      description: 'Scrape a URL and return page content as markdown. Use to discover tech stack, architecture patterns, and product signals.',
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          url: { type: SchemaType.STRING, description: 'Absolute HTTP/S URL to scrape.' },
        },
        required: ['url'],
      },
    },
    {
      name: 'search_x_tweets',
      description: 'Search recent X (Twitter) posts. Use to find technical announcements from the target company handle.',
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          query:      { type: SchemaType.STRING,  description: 'X search query string.' },
          maxResults: { type: SchemaType.INTEGER, description: 'Tweets to return. 5–10. Default 10.' },
        },
        required: ['query'],
      },
    },
  ],
};
```

---

## Loop Algorithm

```
run(queueItemId, context):
  1. Read profile + annotation from queue_items
  2. SET queue_items.status = 'agent-running'
  3. INSERT agent_runs row (status='running')
  4. Build Content[] history = [{ role:'user', parts:[{ text: initialPrompt }] }]

executeLoop(runId, history):
  argCountMap = Map<callKey, count>   // argument-aware repeat tracking
  nameCountMap = Map<toolName, count> // name-only backstop
  iterationCount = 0

  WHILE iterationCount < maxIterations:
    iterationCount++
    PERSIST iteration_count + history_json to agent_runs
    result = await generateContent({ contents: history })
    history.push(result.candidates[0].content)     // role:'model'

    IF no functionCalls in result:
      PERSIST history_json
      RETURN parseDraft(result.text())              // terminal: text response

    FOR each call in functionCalls:
      increment argCountMap[call.name+hash(call.args)]
      increment nameCountMap[call.name]
      IF argCount > maxToolRepeats OR nameCount > 5:
        RETURN finalizeBudgetExhausted('repeat_limit')

    results = await Promise.allSettled(dispatchTool(call) for each call)
    history.push({ role:'function', parts: [functionResponseParts] })
    PERSIST history_json                            // critical invariant

  RETURN finalizeBudgetExhausted('iteration_limit')

finalizeBudgetExhausted(reason):
  SET agent_runs.status = 'budget_exhausted'
  Append budget message to history: "... produce best-effort draft now ..."
  result = await generateContent({ contents: history })
  RETURN parseDraft(result.text())

parseDraft(text):
  IF text.trim() == 'NO_SIGNALS_FOUND': return { subject: null, body: 'NO_SIGNALS_FOUND' }
  Extract SUBJECT: line and body
  RETURN { subject, body }
```

---

## Repeat-Call Tracking

- **Argument-aware key**: `tool_name + ":" + sha256(JSON.stringify(args)).slice(0,12)`
- **Limit**: `argCount > maxToolRepeats` (i.e., 3rd identical call when default=2 → abort)
- **Name-only backstop**: `nameCount > 5` (6th call to same tool name regardless of args → abort)
- Both checks happen *before* tool dispatch — counts are not decremented on error

---

## Recovery Semantics

- Resume point: start of next LLM turn using persisted `history_json`
- `history_json` is written after every tool result batch, before the next `generateContent` call
- Irrecoverable window: tool call dispatched but process died before tool result persisted
  - Detection: `status='running'` + `started_at` older than 15 min → mark `failed`, rollback queue item to `reviewed`
- Stale run check is performed by `resumeIfIncomplete(queueItemId)`
