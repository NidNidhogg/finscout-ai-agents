/**
 * draft-linter.ts — mechanical pre-HITL checks on outreach drafts.
 *
 * Pure functions, no LLM. Encodes the hard rules of the Baron Sever system
 * prompt (4-sentence framework, no placeholders, verbatim salutation,
 * strict no-handle policy) as code, so a prompt regression is caught before
 * the draft reaches the human reviewer.
 */

import type { EnrichedProfile } from '../schema/enrichedProfile';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ViolationSeverity = 'hard' | 'soft';

export interface DraftViolation {
  rule: string;
  severity: ViolationSeverity;
  detail: string;
}

export interface DraftLintResult {
  /** 0.0 – 1.0; 1.0 = all checks passed. */
  score: number;
  violations: DraftViolation[];
  sentenceCount: number | null;
}

export interface LintableDraft {
  subject: string;
  body: string;
}

// ── Sentence counting ─────────────────────────────────────────────────────────

// Abbreviations that would otherwise inflate the sentence count.
const ABBREV_RE = /\b(?:e\.g|i\.e|etc|vs|cf|approx|dept|inc|ltd|no)\./gi;
const URL_RE = /(?:https?:\/\/|www\.)\S+/g;
// Bare domains like acme.io — a dot inside a word is not a sentence end.
const DOMAIN_RE = /\b[\w-]+\.(?:io|com|net|org|fi|xyz|app|dev|co|ai|eth|gg|so|me|info)\b/gi;
// Decimal numbers like 2.0 or $1.5M.
const DECIMAL_RE = /\d\.\d/g;

function countSentences(text: string): number {
  const cleaned = text
    .replace(URL_RE, ' ')
    .replace(DOMAIN_RE, ' ')
    .replace(DECIMAL_RE, (m) => m.replace('.', ''))
    .replace(ABBREV_RE, (m) => m.slice(0, -1))
    .replace(/\.{2,}/g, '.'); // collapse ellipses
  const matches = cleaned.match(/[.!?]+(?=\s|$)/g);
  return matches ? matches.length : 0;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const PLACEHOLDER_RE = /\[[^\]\n]{1,60}\]|\{\{[^}\n]{1,60}\}\}/;
const HANDLE_RE = /(^|\s)@[\w]{2,30}\b/;

function expectedSalutation(profile: EnrichedProfile): string {
  const firstName = profile.team.founders[0]?.name?.trim().split(/\s+/)[0];
  return firstName ? `Hey ${firstName},` : 'Greetings,';
}

/** Body split: first non-empty line = salutation, last non-empty line = sign-off. */
function bodyParts(body: string): { salutation: string | null; middle: string; signOff: string | null } {
  const lines = body.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return { salutation: null, middle: '', signOff: null };
  if (lines.length === 1) return { salutation: lines[0]!, middle: '', signOff: null };
  return {
    salutation: lines[0]!,
    middle: lines.slice(1, -1).join(' '),
    signOff: lines[lines.length - 1]!,
  };
}

// ── Main lint ─────────────────────────────────────────────────────────────────

export function lintDraft(
  draft: LintableDraft,
  profile: EnrichedProfile,
): DraftLintResult {
  const violations: DraftViolation[] = [];
  const subject = draft.subject ?? '';
  const body = draft.body ?? '';
  const { salutation, middle, signOff } = bodyParts(body);

  // Subject rules (system prompt: lowercase, ≤8 words, no exclamation marks).
  if (!subject.trim()) {
    violations.push({ rule: 'subject_present', severity: 'hard', detail: 'Subject line is empty.' });
  } else {
    const words = subject.trim().split(/\s+/);
    if (words.length > 8) {
      violations.push({
        rule: 'subject_word_count',
        severity: 'soft',
        detail: `Subject has ${words.length} words (limit 8).`,
      });
    }
    if (subject !== subject.toLowerCase()) {
      violations.push({
        rule: 'subject_lowercase',
        severity: 'soft',
        detail: 'Subject contains uppercase characters.',
      });
    }
    if (subject.includes('!')) {
      violations.push({
        rule: 'subject_no_exclamation',
        severity: 'soft',
        detail: 'Subject contains an exclamation mark.',
      });
    }
  }

  // No placeholders anywhere (hard rule in system prompt).
  if (PLACEHOLDER_RE.test(subject) || PLACEHOLDER_RE.test(body)) {
    violations.push({
      rule: 'no_placeholders',
      severity: 'hard',
      detail: 'Bracketed/template placeholder found in subject or body.',
    });
  }

  // Strict handle policy: no @handle at all when the profile has no verified handle.
  const hasVerifiedHandle = Boolean(profile.company.xHandle);
  if (!hasVerifiedHandle && (HANDLE_RE.test(subject) || HANDLE_RE.test(body))) {
    violations.push({
      rule: 'no_invented_handle',
      severity: 'hard',
      detail: 'Draft contains an @handle but the profile has no verified xHandle.',
    });
  }

  // Salutation must match the injected "Salutation to use:" value verbatim.
  const expected = expectedSalutation(profile);
  if (salutation === null) {
    violations.push({ rule: 'salutation_present', severity: 'hard', detail: 'No salutation line.' });
  } else if (salutation !== expected) {
    violations.push({
      rule: 'salutation_verbatim',
      severity: 'soft',
      detail: `Salutation is "${salutation}", expected "${expected}".`,
    });
  }

  // Exactly 4 sentences between salutation and sign-off.
  const sentenceCount = middle.trim() ? countSentences(middle) : 0;
  if (sentenceCount !== 4) {
    violations.push({
      rule: 'sentence_count_4',
      severity: 'hard',
      detail: `Body contains ${sentenceCount} sentences (required: 4).`,
    });
  }

  // Sign-off: "Baron", no company name, no title.
  if (signOff === null) {
    violations.push({ rule: 'signoff_present', severity: 'hard', detail: 'No sign-off line.' });
  } else if (signOff !== 'Baron') {
    violations.push({
      rule: 'signoff_baron',
      severity: 'soft',
      detail: `Sign-off is "${signOff}", expected "Baron".`,
    });
  }

  // Score: hard violations weigh 2x, soft 1x — a single hard violation
  // caps the score at 0.6 so flagged drafts always sort before clean ones.
  const hardCount = violations.filter((v) => v.severity === 'hard').length;
  const softCount = violations.length - hardCount;
  const score = Math.max(0, 1 - hardCount * 0.4 - softCount * 0.1);

  return { score, violations, sentenceCount };
}
