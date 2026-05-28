import { randomUUID, createHash } from 'crypto';
import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import type { Content, FunctionCall, FunctionDeclarationsTool, GenerativeModel } from '@google/generative-ai';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { FirecrawlFetcher } from '../enrichment/website/FirecrawlFetcher';
import { ConcreteXApiClient } from '../enrichment/x-signal/ConcreteXApiClient';
import { EnrichedProfileSchema } from '../schema/enrichedProfile';
import type { EnrichedProfile } from '../schema/enrichedProfile';

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'gemini-2.0-flash';
const DEFAULT_MAX_ITERATIONS = 8;
const DEFAULT_MAX_TOOL_REPEATS = 2;
const NAME_ONLY_BACKSTOP = 5;
const MARKDOWN_CAP = 8_000;

export const NO_SIGNALS_SENTINEL = 'NO_SIGNALS_FOUND';

const SYSTEM_INSTRUCTION = `You are Baron Sever, a Senior Architect and CBDO of iDECP Venture Builder (DeFi | Equity, Crypto, and Payments). Your style is sophisticated, highly technical, direct, and zero-fluff. You speak founder-to-founder and architect-to-architect.

TASK: Research a target company using your tools, then write a personalised cold outbound email following the 4-sentence framework below.

TOOLS AVAILABLE:
• crawl_website(url) — scrapes a URL and returns the page as markdown. Use to discover tech stack, architecture patterns, and product signals.
• search_x_tweets(query, maxResults?) — returns recent X posts. Use to find technical announcements from the target company.

RESEARCH STRATEGY:
1. Call crawl_website on the company website if one is provided.
2. Call search_x_tweets targeting the company's X handle for recent technical posts. If X Handle is "(none)", skip search_x_tweets entirely — do NOT guess a handle.
3. Stop once you have ≥1 concrete technical signal, or once both tools have been tried.

EMAIL FRAMEWORK (4 sentences):
1. Hook — cite 1–2 specific signals you discovered. No "I came across your company."
2. Hypothesis — name the precise architectural risk implied by their stack and raise stage.
3. Value Drop — one sentence on how iDECP eliminates this. Follow the source framing provided.
4. CTA — one low-friction question. No calendar link. No "let's hop on a call."

REQUIREMENTS:
- Subject: lowercase, ≤8 words, technically specific. No exclamation marks.
- Salutation: Use the exact value of "Salutation to use:" from the "## Primary Contact" section. Copy it verbatim — no substitution, no improvisation.
- Body: exactly 4 sentences.
- Sign-off: Baron (no company name, no title)
- NO PLACEHOLDERS — HARD RULE: Never output bracketed template variables such as "[first name]", "[Name]", "[Company]", or any "[…]" pattern anywhere in the subject or body. If a piece of information is absent, write around it — do not insert a placeholder.

LEVERAGE SIGNALS — injected per lead, use when present:
- Pain Hypothesis: The pre-validated architectural pain for this company. Your Hypothesis sentence (sentence 2) MUST be grounded in this specific hypothesis — elaborate and sharpen it with your research, do NOT replace it with a generic one.
- TVL Context: If provided (e.g., "$45M TVL in Liquid Staking"), use it in the Hook to quantify the scale at which the pain becomes critical (e.g., "at $45M TVL, settlement latency is no longer a dev problem — it is a P&L problem").
- Funding VC: If a VC name is provided, use it as a warm framing hook or social proof anchor in the Hook (e.g., "Post-[VC] raise, the next 6 months are when architectural shortcuts compound into hard walls"). Never invent or guess a VC name — only use what is explicitly provided.
- Primary Contact Handle: If provided (X, LinkedIn, or GitHub), you may reference it in the hook. Never invent a handle.

STRICT HANDLE POLICY — MANDATORY:
You are STRICTLY FORBIDDEN from inventing, guessing, or hallucinating an X (Twitter) handle based on a company name, domain, or any other heuristic.
If the target's "X Handle" field is "(none)", you MUST NOT output any string prefixed with "@" anywhere in the email subject or body.
When X Handle is "(none)", use the company's verified website domain as the primary asset identifier in your hook and subject line (e.g. "acme.io" not "@acme").
Violation of this policy produces hallucinated output and is treated as a hard failure.

OUTPUT FORMAT — choose exactly one:

If you found technical signals:
SUBJECT: <subject line>

<email body ending with "Baron">

If NO technical signals found after using both tools:
NO_SIGNALS_FOUND`;

// ── Gemini tool declarations ───────────────────────────────────────────────────

const HARNESS_TOOLS: FunctionDeclarationsTool = {
  functionDeclarations: [
    {
      name: 'crawl_website',
      description:
        'Scrape a URL and return the page content as markdown. Use to discover tech stack, architecture patterns, and product signals.',
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          url: {
            type: SchemaType.STRING,
            description: 'Absolute HTTP/S URL to scrape.',
          },
        },
        required: ['url'],
      },
    },
    {
      name: 'search_x_tweets',
      description:
        'Search recent X (Twitter) posts. Use to find technical announcements from the target company handle.',
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          query: {
            type: SchemaType.STRING,
            description: 'X search query string.',
          },
          maxResults: {
            type: SchemaType.INTEGER,
            description: 'Number of tweets to return. Between 5 and 10. Defaults to 10.',
          },
        },
        required: ['query'],
      },
    },
  ],
};

// ── Zod schemas (runtime arg validation inside harness) ───────────────────────

const CrawlWebsiteInputSchema = z.object({
  url: z.string().url(),
});

const SearchXTweetsInputSchema = z.object({
  query: z.string().min(1).max(512),
  maxResults: z.number().int().min(5).max(10).default(10),
});

// ── Public types ───────────────────────────────────────────────────────────────

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
  draftBody: string | null;
  errorMessage: string | null;
}

export interface RunContext {
  sourceAngle: string;
  hypothesis: string;
  valueDrop: string;
}

export interface AgentHarnessConfig {
  db: Database.Database;
  geminiApiKey: string;
  firecrawlApiKey: string;
  xBearerToken: string;
  model?: string;
  maxIterations?: number;
  maxToolRepeats?: number;
}

// ── Internal types ─────────────────────────────────────────────────────────────

interface ParsedDraft {
  subject: string | null;
  body: string;
}

interface ReviewAnnotationPartial {
  tier?: string;
  tierReason?: string;
  reviewerNote?: string;
}

interface QueueItemRow {
  profile_json: string;
  annotation_json: string | null;
}

interface AgentRunRow {
  id: string;
  queue_item_id: string;
  status: string;
  model: string;
  started_at: string;
  completed_at: string | null;
  iteration_count: number;
  history_json: string;
  draft_subject: string | null;
  draft_body: string | null;
  error_message: string | null;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function hashArgs(args: object): string {
  return createHash('sha256').update(JSON.stringify(args)).digest('hex').slice(0, 12);
}

// Returns the first founder's first name and best available handle.
// All fields are sourced from what Upgrade 2 extracted verbatim — never inferred.
function resolvePrimaryContact(profile: EnrichedProfile): {
  firstName: string | null;
  handle: string | null;
} {
  const founder = profile.team.founders[0];
  if (!founder) return { firstName: null, handle: null };
  const firstName = founder.name?.trim().split(/\s+/)[0] ?? null;
  // Prefer X handle for direct social reach; fall back to LinkedIn or GitHub profile URLs.
  const handle =
    founder.xHandle ??
    (founder.linkedinUrl ? `LinkedIn: ${founder.linkedinUrl}` : null) ??
    (founder.githubUrl  ? `GitHub: ${founder.githubUrl}`   : null) ??
    null;
  return { firstName, handle };
}

// Extracts the lead VC name from the original source tweet text (X-Radar path only).
// Pattern: "led by Paradigm" / "backed by a16z crypto" — capped at 80 chars.
// Returns null for DeFiLlama entries (no tweet) or when pattern is absent.
function extractFundingVC(profile: EnrichedProfile): string | null {
  const tweetText = profile.rawContent.sourceTweets?.[0]?.text ?? '';
  if (!tweetText) return null;
  const match = /(?:led|backed)\s+by\s+([\w\s&.,/]+?)(?=[.!?\n]|$)/i.exec(tweetText);
  return match ? match[1].trim().slice(0, 80) : null;
}

// Formats TVL + DeFiLlama category into a single leverage string.
// Returns null for non-DeFiLlama entries.
function formatTVLContext(profile: EnrichedProfile): string | null {
  const rawText = profile.funding.claimed?.rawText ?? '';
  const tvlMatch = /DefiLlama TVL:\s*(\$[\d.]+[MBk])/i.exec(rawText);
  if (!tvlMatch) return null;
  const category = profile.product.selfClaimedCategory;
  return category ? `${tvlMatch[1]} TVL in ${category}` : `${tvlMatch[1]} TVL`;
}

function formatUSD(amount: number): string {
  if (amount >= 1_000_000_000) return `$${(amount / 1_000_000_000).toFixed(1)}B`;
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(0)}M`;
  if (amount >= 1_000) return `$${(amount / 1_000).toFixed(0)}k`;
  return `$${amount}`;
}

function parseDraft(raw: string): ParsedDraft {
  const trimmed = raw.trim();
  if (trimmed === NO_SIGNALS_SENTINEL) return { subject: null, body: NO_SIGNALS_SENTINEL };

  const lines = trimmed.split('\n');
  const subjectLine = lines.find((l) => l.toLowerCase().startsWith('subject:'));
  const subject = subjectLine ? subjectLine.replace(/^subject:\s*/i, '').trim() : null;
  const subjectIdx = lines.findIndex((l) => l.toLowerCase().startsWith('subject:'));
  const bodyLines = subjectIdx >= 0 ? lines.slice(subjectIdx + 1) : lines;
  const body = bodyLines.join('\n').replace(/^\n+/, '').trim();
  return { subject, body };
}

// ── AgentExecutionHarness ──────────────────────────────────────────────────────

export class AgentExecutionHarness {
  private readonly db: Database.Database;
  private readonly genAI: GoogleGenerativeAI;
  private readonly firecrawl: FirecrawlFetcher;
  private readonly xClient: ConcreteXApiClient;
  private readonly model: string;
  private readonly maxIterations: number;
  private readonly maxToolRepeats: number;

  constructor(config: AgentHarnessConfig) {
    this.db = config.db;
    this.genAI = new GoogleGenerativeAI(config.geminiApiKey);
    this.firecrawl = new FirecrawlFetcher({ apiKey: config.firecrawlApiKey });
    this.xClient = new ConcreteXApiClient({ bearerToken: config.xBearerToken });
    this.model = config.model ?? DEFAULT_MODEL;
    this.maxIterations = config.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    this.maxToolRepeats = config.maxToolRepeats ?? DEFAULT_MAX_TOOL_REPEATS;
    this.ensureSchema();
    this.recoverGhostStates();
  }

  /**
   * Resets any queue_items stuck in 'agent-running' that have no actively running agent_run
   * (or whose run is older than the 15-minute stale cutoff).  Call site: constructor — runs
   * synchronously at startup so a SIGTERM/Ctrl-C during a prior run cannot leave ghost state.
   */
  recoverGhostStates(): void {
    const staleCutoff = new Date(Date.now() - 15 * 60 * 1_000).toISOString();
    this.db
      .prepare(
        `UPDATE queue_items
         SET status = 'reviewed'
         WHERE status = 'agent-running'
           AND NOT EXISTS (
             SELECT 1 FROM agent_runs
              WHERE queue_item_id = queue_items.id
                AND status = 'running'
                AND started_at > ?
           )`,
      )
      .run(staleCutoff);
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_runs (
        id              TEXT PRIMARY KEY,
        queue_item_id   TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'running',
        model           TEXT NOT NULL,
        started_at      TEXT NOT NULL,
        completed_at    TEXT,
        iteration_count INTEGER NOT NULL DEFAULT 0,
        history_json    TEXT NOT NULL DEFAULT '[]',
        draft_subject   TEXT,
        draft_body      TEXT,
        error_message   TEXT,
        FOREIGN KEY (queue_item_id) REFERENCES queue_items(id)
      )
    `);
  }

  async run(queueItemId: string, context: RunContext): Promise<AgentRunRecord> {
    const row = this.db
      .prepare<[string], QueueItemRow>(
        'SELECT profile_json, annotation_json FROM queue_items WHERE id = ?',
      )
      .get(queueItemId);

    if (!row) throw new Error(`Queue item ${queueItemId} not found`);

    const profile = EnrichedProfileSchema.parse(JSON.parse(row.profile_json));
    const annotation: ReviewAnnotationPartial = row.annotation_json
      ? (JSON.parse(row.annotation_json) as ReviewAnnotationPartial)
      : {};

    this.db
      .prepare<[string], void>("UPDATE queue_items SET status = 'agent-running' WHERE id = ?")
      .run(queueItemId);

    const runId = randomUUID();
    const startedAt = new Date().toISOString();

    this.db
      .prepare<[string, string, string, string], void>(
        "INSERT INTO agent_runs (id, queue_item_id, status, model, started_at, history_json) VALUES (?, ?, 'running', ?, ?, '[]')",
      )
      .run(runId, queueItemId, this.model, startedAt);

    const initialHistory: Content[] = [
      {
        role: 'user',
        parts: [{ text: this.buildInitialPrompt(profile, annotation, context) }],
      },
    ];

    try {
      const draft = await this.executeLoop(runId, initialHistory);
      const completedAt = new Date().toISOString();

      // Preserve 'budget_exhausted' status set by finalizeBudgetExhausted — don't overwrite with 'completed'
      const runStatusRow = this.db
        .prepare<[string], { status: string }>('SELECT status FROM agent_runs WHERE id = ?')
        .get(runId)!;
      const finalRunStatus =
        runStatusRow.status === 'budget_exhausted' ? 'budget_exhausted' : 'completed';

      this.db
        .prepare<[string, string, string | null, string, string], void>(
          'UPDATE agent_runs SET status = ?, completed_at = ?, draft_subject = ?, draft_body = ? WHERE id = ?',
        )
        .run(finalRunStatus, completedAt, draft.subject, draft.body, runId);

      const finalQueueStatus = draft.body === NO_SIGNALS_SENTINEL ? 'discarded' : 'drafted';
      this.db
        .prepare<[string], void>(`UPDATE queue_items SET status = '${finalQueueStatus}' WHERE id = ?`)
        .run(queueItemId);

      return this.loadRecord(runId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.db
        .prepare<[string, string], void>(
          "UPDATE agent_runs SET status = 'failed', error_message = ? WHERE id = ?",
        )
        .run(msg, runId);
      this.db
        .prepare<[string], void>("UPDATE queue_items SET status = 'reviewed' WHERE id = ?")
        .run(queueItemId);
      throw err;
    }
  }

  async resumeIfIncomplete(queueItemId: string): Promise<AgentRunRecord | null> {
    const runRow = this.db
      .prepare<[string], { id: string; history_json: string; started_at: string }>(
        "SELECT id, history_json, started_at FROM agent_runs WHERE queue_item_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1",
      )
      .get(queueItemId);

    if (!runRow) return null;

    const staleCutoff = new Date(Date.now() - 15 * 60 * 1_000).toISOString();
    if (runRow.started_at > staleCutoff) {
      return this.loadRecord(runRow.id);
    }

    const history = JSON.parse(runRow.history_json) as Content[];
    if (history.length === 0) {
      this.db
        .prepare<[string], void>(
          "UPDATE agent_runs SET status = 'failed', error_message = 'Stale run with empty history — cannot resume' WHERE id = ?",
        )
        .run(runRow.id);
      this.db
        .prepare<[string], void>("UPDATE queue_items SET status = 'reviewed' WHERE id = ?")
        .run(queueItemId);
      return null;
    }

    try {
      const draft = await this.executeLoop(runRow.id, history);
      const completedAt = new Date().toISOString();
      this.db
        .prepare<[string, string | null, string, string], void>(
          "UPDATE agent_runs SET status = 'completed', completed_at = ?, draft_subject = ?, draft_body = ? WHERE id = ?",
        )
        .run(completedAt, draft.subject, draft.body, runRow.id);
      const finalQueueStatus = draft.body === NO_SIGNALS_SENTINEL ? 'discarded' : 'drafted';
      this.db
        .prepare<[string], void>(`UPDATE queue_items SET status = '${finalQueueStatus}' WHERE id = ?`)
        .run(queueItemId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.db
        .prepare<[string, string], void>(
          "UPDATE agent_runs SET status = 'failed', error_message = ? WHERE id = ?",
        )
        .run(msg, runRow.id);
      this.db
        .prepare<[string], void>("UPDATE queue_items SET status = 'reviewed' WHERE id = ?")
        .run(queueItemId);
    }

    return this.loadRecord(runRow.id);
  }

  private async executeLoop(runId: string, history: Content[]): Promise<ParsedDraft> {
    const geminiModel = this.genAI.getGenerativeModel({
      model: this.model,
      systemInstruction: SYSTEM_INSTRUCTION,
      tools: [HARNESS_TOOLS],
    });

    const argCountMap = new Map<string, number>();
    const nameCountMap = new Map<string, number>();
    let iterationCount = 0;

    while (iterationCount < this.maxIterations) {
      iterationCount++;

      this.db
        .prepare<[number, string, string], void>(
          'UPDATE agent_runs SET iteration_count = ?, history_json = ? WHERE id = ?',
        )
        .run(iterationCount, JSON.stringify(history), runId);

      const result = await geminiModel.generateContent({ contents: history });
      const response = result.response;
      const candidate = response.candidates?.[0];
      if (!candidate) throw new Error('Gemini returned no candidates');

      history.push(candidate.content);

      const functionCalls = response.functionCalls();

      if (!functionCalls || functionCalls.length === 0) {
        this.db
          .prepare<[string, string], void>('UPDATE agent_runs SET history_json = ? WHERE id = ?')
          .run(JSON.stringify(history), runId);
        return parseDraft(response.text());
      }

      if (this.exceedsRepeatLimits(functionCalls, argCountMap, nameCountMap)) {
        return this.finalizeBudgetExhausted(runId, geminiModel, history, 'repeat_limit');
      }

      const toolResults = await Promise.allSettled(
        functionCalls.map((call) => this.dispatchTool(call)),
      );

      const functionResponseParts = toolResults.map((settled, i) => ({
        functionResponse: {
          name: functionCalls[i]!.name,
          response:
            settled.status === 'fulfilled'
              ? settled.value
              : {
                  error:
                    settled.reason instanceof Error
                      ? settled.reason.message
                      : String(settled.reason),
                },
        },
      }));

      history.push({ role: 'function', parts: functionResponseParts });

      // Persist after tool results — must happen before next generateContent call
      this.db
        .prepare<[string, string], void>('UPDATE agent_runs SET history_json = ? WHERE id = ?')
        .run(JSON.stringify(history), runId);
    }

    return this.finalizeBudgetExhausted(runId, geminiModel, history, 'iteration_limit');
  }

  private async finalizeBudgetExhausted(
    runId: string,
    geminiModel: GenerativeModel,
    history: Content[],
    reason: 'iteration_limit' | 'repeat_limit',
  ): Promise<ParsedDraft> {
    const budgetMessage =
      reason === 'repeat_limit'
        ? 'Repeat-call limit reached. Using what you have gathered so far, produce the final email draft now. Follow the output format exactly.'
        : 'Iteration budget exhausted. Using what you have gathered so far, produce the final email draft now. Follow the output format exactly.';

    history.push({ role: 'user', parts: [{ text: budgetMessage }] });

    this.db
      .prepare<[string, string], void>(
        "UPDATE agent_runs SET status = 'budget_exhausted', history_json = ? WHERE id = ?",
      )
      .run(JSON.stringify(history), runId);

    const result = await geminiModel.generateContent({ contents: history });
    const candidate = result.response.candidates?.[0];
    if (candidate) {
      history.push(candidate.content);
      this.db
        .prepare<[string, string], void>('UPDATE agent_runs SET history_json = ? WHERE id = ?')
        .run(JSON.stringify(history), runId);
    }

    return parseDraft(result.response.text());
  }

  private exceedsRepeatLimits(
    calls: FunctionCall[],
    argCountMap: Map<string, number>,
    nameCountMap: Map<string, number>,
  ): boolean {
    for (const call of calls) {
      const key = `${call.name}:${hashArgs(call.args)}`;
      const argCount = (argCountMap.get(key) ?? 0) + 1;
      argCountMap.set(key, argCount);

      const nameCount = (nameCountMap.get(call.name) ?? 0) + 1;
      nameCountMap.set(call.name, nameCount);

      if (argCount > this.maxToolRepeats || nameCount > NAME_ONLY_BACKSTOP) {
        return true;
      }
    }
    return false;
  }

  private async dispatchTool(call: FunctionCall): Promise<object> {
    if (call.name === 'crawl_website') {
      const input = CrawlWebsiteInputSchema.parse(call.args);
      try {
        const page = await this.firecrawl.fetch(input.url);
        const originalLen = page.markdown.length;
        const markdown =
          originalLen > MARKDOWN_CAP
            ? page.markdown.slice(0, MARKDOWN_CAP) +
              `\n\n[... content truncated from ${originalLen} characters to prevent context overflow ...]`
            : page.markdown;
        return {
          pages: [
            {
              url: page.url,
              title: page.title,
              markdown,
            },
          ],
        };
      } catch (err: unknown) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }

    if (call.name === 'search_x_tweets') {
      const input = SearchXTweetsInputSchema.parse(call.args);
      try {
        const tweets = await this.xClient.searchRecentTweets({
          query: input.query,
          maxResults: input.maxResults,
        });
        return {
          tweets: tweets.map((t) => ({
            id: t.id,
            text: t.text,
            authorHandle: t.authorHandle,
            ...(t.authorBio ? { authorBio: t.authorBio } : {}),
          })),
        };
      } catch (err: unknown) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }

    return { error: `Unknown tool: ${call.name}` };
  }

  private buildInitialPrompt(
    profile: EnrichedProfile,
    annotation: ReviewAnnotationPartial,
    context: RunContext,
  ): string {
    const { company, funding } = profile;

    // ── Leverage signal extraction ─────────────────────────────────────────────
    const primaryContact   = resolvePrimaryContact(profile);
    const fundingVC        = extractFundingVC(profile);
    const tvlContext       = formatTVLContext(profile);
    const painHypothesis   = profile.painHypothesis; // undefined for pre-Upgrade-1 records

    // ── Funding line ───────────────────────────────────────────────────────────
    const fundingLine = [
      funding.claimed?.amountUSD ? formatUSD(funding.claimed.amountUSD) : 'undisclosed',
      funding.claimed?.stage?.replace(/_/g, '-') ?? '',
      funding.claimed?.rawText ? `("${funding.claimed.rawText}")` : '',
    ]
      .filter(Boolean)
      .join(' ');

    const reviewerContext = [annotation.tierReason, annotation.reviewerNote]
      .filter(Boolean)
      .join(' — ');

    // ── Research plan ──────────────────────────────────────────────────────────
    const step1 = company.websiteUrl
      ? `Call crawl_website("${company.websiteUrl}") to discover their tech stack and architecture.`
      : 'No website URL available — skip crawl_website.';

    const step2 = company.xHandle
      ? `Call search_x_tweets targeting "${company.xHandle.replace(/^@/, '')}" for recent technical posts.`
      : 'X Handle is (none) — do NOT call search_x_tweets and do NOT invent a handle.';

    // ── Domain anchor (for handle-less profiles) ───────────────────────────────
    const domainAnchor = (!company.xHandle && company.websiteUrl)
      ? (() => {
          try { return new URL(company.websiteUrl).hostname.replace(/^\./, '').replace(/^www\./, ''); }
          catch { return null; }
        })()
      : null;

    const handleNote = domainAnchor
      ? `\n\n⚠️  NO X HANDLE: Do NOT invent or guess an X handle. Use the verified domain "${domainAnchor}" as the primary identifier in the subject line and hook.`
      : '';

    // ── Primary contact block ──────────────────────────────────────────────────
    // When a founder name is present: the LLM gets an exact "Salutation to use:" value.
    // When absent: we supply an equally exact fallback so the model never has to guess
    // or reach for a bracketed placeholder.
    const contactLines: string[] = [];
    if (primaryContact.firstName) {
      contactLines.push(`Name: ${primaryContact.firstName}`);
      if (primaryContact.handle) contactLines.push(`Handle: ${primaryContact.handle}`);
      contactLines.push(`Salutation to use: Hey ${primaryContact.firstName},`);
    } else {
      contactLines.push('No founder name available.');
      contactLines.push('Salutation to use: Greetings,');
      contactLines.push('IMPORTANT: Do NOT write any bracketed placeholder (e.g. "[first name]", "[Name]"). Use exactly the salutation above.');
    }
    const contactBlock = contactLines.join('\n');

    // ── Leverage signals block — only include fields that are actually present ─
    const leverageLines: string[] = [];
    if (painHypothesis) leverageLines.push(`Pain Hypothesis: ${painHypothesis}`);
    if (tvlContext)     leverageLines.push(`TVL Context: ${tvlContext}`);
    if (fundingVC)      leverageLines.push(`Funding VC: ${fundingVC}`);
    const leverageBlock = leverageLines.length > 0
      ? `\n\n## Leverage Signals\n${leverageLines.join('\n')}`
      : '';

    return `Research and draft for the following company.

## Target
Name: ${company.name}
X Handle: ${company.xHandle ?? '(none)'}
Website: ${company.websiteUrl ?? '(none)'}
Funding: ${fundingLine}${reviewerContext ? `\nReviewer Notes: ${reviewerContext}` : ''}${handleNote}

## Primary Contact
${contactBlock}

## Research Plan
1. ${step1}
2. ${step2}

## Framing for this Lead
Source context: ${context.sourceAngle}
Hypothesis angle: ${context.hypothesis}
Value Drop angle: ${context.valueDrop}${leverageBlock}`;
  }

  private loadRecord(runId: string): AgentRunRecord {
    const row = this.db
      .prepare<[string], AgentRunRow>('SELECT * FROM agent_runs WHERE id = ?')
      .get(runId);

    if (!row) throw new Error(`agent_run ${runId} not found`);

    return {
      id: row.id,
      queueItemId: row.queue_item_id,
      status: row.status as AgentRunStatus,
      model: row.model,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      iterationCount: row.iteration_count,
      draftSubject: row.draft_subject,
      draftBody: row.draft_body,
      errorMessage: row.error_message,
    };
  }
}
