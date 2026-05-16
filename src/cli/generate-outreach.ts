/**
 * Module C — Soft Launch outreach draft generator.
 * Reads all `reviewed` queue items, generates a personalised cold email for each
 * using the Baron Sever / 4-sentence framework, writes a single Markdown file to
 * data/exports/, and flips each record's status to `drafted`.
 *
 * Usage:
 *   npx ts-node src/cli/generate-outreach.ts
 *
 * Requires: GEMINI_API_KEY, REVIEW_DB_PATH (optional, defaults to data/review-queue.db)
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';
import Database from 'better-sqlite3';
import { EnrichedProfileSchema } from '../schema/enrichedProfile';

// ── Config ────────────────────────────────────────────────────────────────────

const DB_PATH = process.env['REVIEW_DB_PATH'] ?? 'data/review-queue.db';
const EXPORTS_DIR = 'data/exports';
const MODEL = 'gemini-2.0-flash';

// ── Types ─────────────────────────────────────────────────────────────────────

interface QueueRow {
  id: string;
  profile_json: string;
  annotation_json: string | null;
}

interface ReviewAnnotationPartial {
  tier?: string;
  tierReason?: string;
  reviewerNote?: string;
}

interface EmailDraft {
  profileId: string;
  companyName: string;
  xHandle: string;
  subject: string;
  body: string;
}

// ── Source routing ────────────────────────────────────────────────────────────

type LeadSource = 'cryptorank' | 'funding-radar' | 'x-radar' | 'defillama' | 'unknown';

function detectSource(profile: ReturnType<typeof EnrichedProfileSchema.parse>): LeadSource {
  const rawText = profile.funding.claimed?.rawText ?? '';
  if (rawText.startsWith('CryptoRank:')) return 'cryptorank';
  if (rawText.startsWith('Funding Radar:')) return 'funding-radar';
  if (rawText.startsWith('X-Radar:')) return 'x-radar';
  if (rawText.startsWith('DefiLlama TVL:')) return 'defillama';
  return 'unknown';
}

const SOURCE_ANGLE: Record<LeadSource, string> = {
  cryptorank:      'CryptoRank Funding Radar — recent raise (MVA / post-raise technical debt prevention)',
  'funding-radar': 'DefiLlama Raises — recently funded Web3 project (MVA / post-raise technical debt prevention)',
  'x-radar':       'X Funding Radar — announced raise detected via Twitter/X (MVA / post-raise technical debt prevention)',
  defillama:       'DefiLlama — live on-chain protocol (Zero-Trust, HSM, high-load security)',
  unknown:         'direct / manual injection',
};

// Steps 2–3 of the 4-sentence framework vary by source. Step 1 (Hook) and Step 4 (CTA) are invariant.
const FRAMEWORK_BY_SOURCE: Record<LeadSource, { hypothesis: string; valueDrop: string }> = {
  'x-radar': {
    hypothesis:
      '**Hypothesis** — Name a precise architectural risk *implied* by their stack and raise stage. ' +
      'Focus on post-raise technical debt traps: premature abstractions locked in at MVP phase, ' +
      'synchronous bottlenecks that survive into production, missing observability at persistence ' +
      'boundaries, or auth/key management shortcuts that compound into security liabilities at scale.',
    valueDrop:
      '**Value Drop** — One sentence on how iDECP\'s MVA approach eliminates this. ' +
      'Angle: a 6–12 week Minimum Viable Architecture engagement is purpose-built to avoid the ' +
      '"quick and dirty" trap — the architectural choices made in weeks 1–4 post-raise that cause ' +
      '70% of teams to hit a hard scaling wall at 12 months. Result: 40% less technical debt, ' +
      'no throwaway code. "Start Fast and Simple, Build Right."',
  },
  'funding-radar': {
    hypothesis:
      '**Hypothesis** — Name a precise architectural risk *implied* by their stack and raise stage. ' +
      'Focus on post-raise technical debt traps: premature abstractions locked in at MVP phase, ' +
      'synchronous bottlenecks that survive into production, missing observability at persistence ' +
      'boundaries, or auth/key management shortcuts that compound into security liabilities at scale.',
    valueDrop:
      '**Value Drop** — One sentence on how iDECP\'s MVA approach eliminates this. ' +
      'Angle: a 6–12 week Minimum Viable Architecture engagement is purpose-built to avoid the ' +
      '"quick and dirty" trap — the architectural choices made in weeks 1–4 post-raise that cause ' +
      '70% of teams to hit a hard scaling wall at 12 months. Result: 40% less technical debt, ' +
      'no throwaway code. "Start Fast and Simple, Build Right."',
  },
  cryptorank: {
    hypothesis:
      '**Hypothesis** — Name a precise architectural risk *implied* by their stack and raise stage. ' +
      'Focus on post-raise technical debt traps: premature abstractions locked in at MVP phase, ' +
      'synchronous bottlenecks that survive into production, missing observability at persistence ' +
      'boundaries, or auth/key management shortcuts that compound into security liabilities at scale.',
    valueDrop:
      '**Value Drop** — One sentence on how iDECP\'s MVA approach eliminates this. ' +
      'Angle: a 6–12 week Minimum Viable Architecture engagement is purpose-built to avoid the ' +
      '"quick and dirty" trap — the architectural choices made in weeks 1–4 post-raise that cause ' +
      '70% of teams to hit a hard scaling wall at 12 months. Result: 40% less technical debt, ' +
      'no throwaway code. "Start Fast and Simple, Build Right."',
  },
  defillama: {
    hypothesis:
      '**Hypothesis** — Name a precise architectural, scaling, or security challenge *implied* by their ' +
      'signals (e.g., multi-sig coordination under load, settlement finality risk under adversarial ' +
      'conditions, key management at HSM tier, intent-relay latency).',
    valueDrop:
      '**Value Drop** — One sentence on how iDECP addresses this. ' +
      'Choose the angle that fits: Zero-Trust backends, MVA for high-load async systems, ' +
      'cross-chain security primitives, or HSM-grade key management.',
  },
  unknown: {
    hypothesis:
      '**Hypothesis** — Name a precise architectural, scaling, or security challenge *implied* by their ' +
      'signals (e.g., multi-sig coordination under load, settlement finality risk under adversarial ' +
      'conditions, key management at HSM tier, intent-relay latency).',
    valueDrop:
      '**Value Drop** — One sentence on how iDECP addresses this. ' +
      'Choose the angle that fits: Minimum Viable Architecture, Zero-Trust backends, ' +
      'cross-chain security primitives, high-load async systems, or HSM-grade key management.',
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatUSD(amount: number | null | undefined): string {
  if (!amount) return 'undisclosed';
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(0)}M`;
  if (amount >= 1_000) return `$${(amount / 1_000).toFixed(0)}k`;
  return `$${amount}`;
}

function buildUserPrompt(
  profile: ReturnType<typeof EnrichedProfileSchema.parse>,
  annotation: ReviewAnnotationPartial,
  source: LeadSource,
): string {
  const { company, funding, product } = profile;

  const fundingLine = [
    formatUSD(funding.claimed?.amountUSD),
    funding.claimed?.stage?.replace('_', '-') ?? '',
    funding.claimed?.rawText ? `— "${funding.claimed.rawText}"` : '',
  ]
    .filter(Boolean)
    .join(' ');

  const stackLine =
    product.stackMentions.length > 0 ? product.stackMentions.join(', ') : '(none detected via crawl)';

  const archLine =
    product.architectureTerms.length > 0
      ? product.architectureTerms.join(', ')
      : '(none detected via crawl)';

  const topCells = product.competencyCellMatches
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map((c) => `${c.cell} (score: ${c.score.toFixed(2)})`)
    .join(', ');

  const reviewerContext = [annotation.tierReason, annotation.reviewerNote]
    .filter(Boolean)
    .join(' — ');

  return `Write a cold outbound email from Baron Sever to the founders of the following company.

## Target Company

**Name:** ${company.name}
**X Handle:** ${company.xHandle ?? '(unknown)'}
**Website:** ${company.websiteUrl ?? '(none)'}
**Funding event:** ${fundingLine}
**Architecture signals:** ${archLine}
**Tech stack:** ${stackLine}
**Competency cells:** ${topCells || '(none scored)'}
**Reviewer context:** ${reviewerContext || '(none)'}
**Source angle:** ${SOURCE_ANGLE[source]}

## 4-Sentence Framework

1. **Hook** — Acknowledge their recent funding and reference 1–2 specific signals from their architecture or stack above. Make it clear you did your homework, not a template scan.
2. ${FRAMEWORK_BY_SOURCE[source].hypothesis}
3. ${FRAMEWORK_BY_SOURCE[source].valueDrop}
4. **CTA** — One low-friction question. No calendar link. No "let's hop on a call." No pressure.

## Requirements

- Subject line: lowercase, ≤8 words, technical (no exclamation marks, no "congrats on the raise", no "quick question")
- Salutation: Hey [first name], — leave [first name] as a literal placeholder
- Body: 4 sentences only. No filler opener. No "I came across your company."
- Sign-off: Baron
- Do NOT include a company name or title in the sign-off

## Output format (strict — no markdown, no extra text)

SUBJECT: <subject line>

<full email including salutation and sign-off>`;
}

function parseModelResponse(raw: string): { subject: string; body: string } {
  const lines = raw.trim().split('\n');
  const subjectLine = lines.find((l) => l.toLowerCase().startsWith('subject:'));
  const subject = subjectLine ? subjectLine.replace(/^subject:\s*/i, '').trim() : '(no subject)';

  // Body starts after the blank line following SUBJECT:
  const subjectIdx = lines.findIndex((l) => l.toLowerCase().startsWith('subject:'));
  const bodyLines = subjectIdx >= 0 ? lines.slice(subjectIdx + 1) : lines;
  const body = bodyLines
    .join('\n')
    .replace(/^\n+/, '')
    .trim();

  return { subject, body };
}

function renderMarkdown(drafts: EmailDraft[], generatedAt: string): string {
  const header = [
    '# iDECP Outreach Drafts — Soft Launch',
    '',
    `**Generated:** ${generatedAt}  `,
    `**Model:** ${MODEL}  `,
    `**Drafts:** ${drafts.length}`,
    '',
    '> Human-in-the-loop. Review each draft, edit as needed, send manually.',
    '',
    '---',
    '',
  ].join('\n');

  const sections = drafts.map((d, i) => {
    return [
      `## ${i + 1}. ${d.companyName} · ${d.xHandle}`,
      '',
      `**Subject:** \`${d.subject}\``,
      '',
      '```',
      d.body,
      '```',
      '',
      '---',
      '',
    ].join('\n');
  });

  return header + sections.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const apiKey = process.env['GEMINI_API_KEY'];
  if (!apiKey) {
    console.error('[generate-outreach] ERROR: GEMINI_API_KEY is required.');
    process.exit(1);
  }

  const db = new Database(DB_PATH);
  const genAI = new GoogleGenerativeAI(apiKey);

  const rows = db
    .prepare<[], QueueRow>(`SELECT id, profile_json, annotation_json FROM queue_items WHERE status = 'reviewed'`)
    .all();

  if (rows.length === 0) {
    console.log('[generate-outreach] No reviewed profiles found. Nothing to draft.');
    process.exit(0);
  }

  console.log(`[generate-outreach] Found ${rows.length} reviewed profile(s). Drafting…\n`);

  const drafts: EmailDraft[] = [];
  const draftStmt = db.prepare<[string], void>(`UPDATE queue_items SET status = 'drafted' WHERE id = ?`);
  const discardStmt = db.prepare<[string], void>(`UPDATE queue_items SET status = 'discarded' WHERE id = ?`);
  let discarded = 0;

  for (const row of rows) {
    const profile = EnrichedProfileSchema.parse(JSON.parse(row.profile_json));
    const annotation: ReviewAnnotationPartial = row.annotation_json
      ? (JSON.parse(row.annotation_json) as ReviewAnnotationPartial)
      : {};

    const companyLabel = `${profile.company.name} (${profile.company.xHandle ?? row.id.slice(0, 8)})`;

    // Circuit breaker: skip profiles with no actionable technical signals
    const hasSignals =
      profile.product.stackMentions.length > 0 ||
      profile.product.architectureTerms.length > 0;

    if (!hasSignals) {
      console.log(`  ⚡ ${companyLabel} — no technical signals, skipping LLM call → discarded`);
      discardStmt.run(row.id);
      discarded++;
      continue;
    }

    const source = detectSource(profile);
    process.stdout.write(`  → ${companyLabel} [${source}]… `);

    const userPrompt = buildUserPrompt(profile, annotation, source);

    const geminiModel = genAI.getGenerativeModel({
      model: MODEL,
      systemInstruction:
        'You are Baron Sever, a Senior Architect and CBDO of iDECP Venture Builder (DeFi | Equity, Crypto, and Payments). ' +
        'Your style is sophisticated, highly technical, direct, and zero-fluff. ' +
        'You speak founder-to-founder and architect-to-architect.',
    });

    const result = await geminiModel.generateContent(userPrompt);
    const rawText = result.response.text();

    const { subject, body } = parseModelResponse(rawText);

    drafts.push({
      profileId: row.id,
      companyName: profile.company.name,
      xHandle: profile.company.xHandle ?? '',
      subject,
      body,
    });

    draftStmt.run(row.id);
    console.log('done');
  }

  // Write markdown file
  fs.mkdirSync(EXPORTS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '');
  const fileTs = ts.replace(/[ :]/g, '-');
  const outPath = path.join(EXPORTS_DIR, `outreach-drafts-${fileTs}.md`);
  const markdown = renderMarkdown(drafts, ts);
  fs.writeFileSync(outPath, markdown, 'utf-8');

  console.log(`\n[generate-outreach] ${drafts.length} draft(s) written → ${outPath}`);
  if (discarded > 0) {
    console.log(`[generate-outreach] ${discarded} profile(s) discarded (circuit breaker: no technical signals).`);
  }
}

main().catch((err: unknown) => {
  console.error('[generate-outreach] Fatal:', err);
  process.exit(1);
});
