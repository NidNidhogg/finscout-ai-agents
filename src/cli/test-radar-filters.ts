/**
 * Smoke-test for X-Radar client-side filter chain.
 *
 * Feeds two previously-missed mock tweets through the same gate logic used by
 * fetch-funding.ts without touching the live X API or database.
 *
 * Run:
 *   npx ts-node src/cli/test-radar-filters.ts
 */

import { extractFundingAmountUSD, isBelowFundingThreshold } from '../enrichment/x-signal/filters';
import { TRUSTED_CRYPTO_VCS } from '../config/trusted-vcs';

// ── Replicated helpers (verbatim from fetch-funding.ts) ───────────────────────

const FUNDING_THRESHOLD_USD = 1_000_000;

const FIRST_PERSON_PATTERNS = [
  'we raised', "we've raised", 'we have raised',
  'we just raised', 'we closed', 'we just closed',
  "we're excited", 'we are excited', 'our round', 'our seed', 'our series',
  'thrilled to announce', 'excited to announce', 'proud to announce',
  'just closed our', 'just raised our', 'announcing our',
];

function normStr(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isAuthorTrustedVC(handle: string, bio?: string): boolean {
  const normHandle = normStr(handle.replace(/^@/, ''));
  const normBio = normStr(bio ?? '');
  return TRUSTED_CRYPTO_VCS.some((vc) => {
    const normVC = normStr(vc);
    return normHandle.includes(normVC) || normBio.includes(normVC);
  });
}

function findLedByVC(text: string): string | null {
  const lower = text.toLowerCase();
  const phraseMatch = /(?:led|backed)\s+by\s+([\s\S]{1,120}?)(?=[.!?\n]|$)/i.exec(lower);
  if (!phraseMatch) return null;
  const afterPhrase = phraseMatch[1];
  return TRUSTED_CRYPTO_VCS.find((vc) => afterPhrase.includes(vc)) ?? null;
}

// ── ANSI helpers ──────────────────────────────────────────────────────────────

const C = {
  reset:  '\x1b[0m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
};

function pass(label: string): string  { return `${C.green}✓ PASS${C.reset}  ${C.dim}(${label})${C.reset}`; }
function fail(label: string): string  { return `${C.red}✗ FAIL${C.reset}  ${C.dim}(${label})${C.reset}`; }
function warn(label: string): string  { return `${C.yellow}⚠ WARN${C.reset}  ${C.dim}(${label})${C.reset}`; }
function row(key: string, val: string): void {
  console.log(`  ${key.padEnd(30)} ${val}`);
}

// ── Mock tweet type ───────────────────────────────────────────────────────────

interface MockTweet {
  label:         string;
  authorHandle:  string;
  authorBio?:    string;
  text:          string;
}

// ── Test cases ────────────────────────────────────────────────────────────────

const MOCK_TWEETS: MockTweet[] = [
  {
    label:        'Checker — decimal amount, Brand Bypass',
    authorHandle: '@checkercorp',
    text:         "We've raised $8.1M to accelerate our mission to secure Web3 infrastructure...",
  },
  {
    label:        'Catena — VC Author Bypass, company-name extraction',
    authorHandle: '@cdixon',
    authorBio:    'General Partner at a16z',
    text:         'Investing in Catena Protocol Part II. Thrilled to back this team building next-gen DeFi routing.',
  },
];

// ── Evaluation ────────────────────────────────────────────────────────────────

function evaluate(tweet: MockTweet): void {
  const lowerText = tweet.text.toLowerCase();

  // Gate 1 — First-person / Brand Bypass
  const matchedPattern = FIRST_PERSON_PATTERNS.find((p) => lowerText.includes(p)) ?? null;
  const isFirstPerson  = matchedPattern !== null;

  // Gate 2 — VC Author Bypass
  const isAuthorVC   = isAuthorTrustedVC(tweet.authorHandle, tweet.authorBio);
  const isInvestingIn = isAuthorVC && lowerText.includes('investing in');

  // Gate 2b — "led by / backed by" VC in text
  const ledByVC   = findLedByVC(tweet.text);
  const isVCBypass = isInvestingIn || ledByVC !== null;

  const passesGate = isFirstPerson || isVCBypass;

  // Amount extraction
  const amountUSD      = extractFundingAmountUSD(tweet.text);
  const belowThreshold = isBelowFundingThreshold(tweet.text, FUNDING_THRESHOLD_USD);
  const passesAmount   = !belowThreshold && amountUSD !== null;

  // Company-name extraction (mirrors fetch-funding.ts)
  let vcPortfolioName: string | null = null;
  if (isInvestingIn) {
    const m = /investing\s+in\s+(?:@)?([A-Za-z][\w\s.-]{1,40}?)(?=\s+for\b|\s+(?:a|the)\s|\s+with\b|\s*[,!.#@]|\s+(?:seed|series|round|funding|raise)\b|$)/i.exec(tweet.text);
    vcPortfolioName = m?.[1]?.trim() ?? null;
  } else if (ledByVC !== null && !isFirstPerson) {
    const m = /^([A-Z][^.!?\n]{2,50}?)(?=\s+(?:raises|raised|closes|closed|secures|secured|announces|announced|completes|completed)\b)/i.exec(tweet.text);
    vcPortfolioName = m?.[1]?.trim() ?? null;
  }

  // ── Print ─────────────────────────────────────────────────────────────────

  const LINE = '─'.repeat(66);
  console.log(`\n${C.bold}${LINE}${C.reset}`);
  console.log(`${C.bold}  ${tweet.label}${C.reset}`);
  console.log(`${C.dim}  Author: ${tweet.authorHandle}${tweet.authorBio ? `  |  Bio: "${tweet.authorBio}"` : ''}${C.reset}`);
  console.log(`${C.dim}  Text:   "${tweet.text}"${C.reset}`);
  console.log(LINE);

  row('First-person pattern:',
      isFirstPerson
        ? pass(`matched "${matchedPattern}"`)
        : `${C.dim}no match${C.reset}`);

  row('Author is trusted VC:',
      isAuthorVC
        ? pass(`normStr handle/bio matched TRUSTED_CRYPTO_VCS`)
        : `${C.dim}not in allowlist${C.reset}`);

  row('"investing in" VC bypass:',
      isInvestingIn ? pass('author is trusted VC + contains "investing in"') : `${C.dim}n/a${C.reset}`);

  row('"led by / backed by" bypass:',
      ledByVC !== null ? pass(`matched VC: "${ledByVC}"`) : `${C.dim}n/a${C.reset}`);

  const gateResult = passesGate
    ? pass('at least one bypass rule triggered')
    : fail('no bypass rules matched — would be dropped');
  row('GATE RESULT:', gateResult);

  console.log();

  row('Extracted amount:',
      amountUSD !== null
        ? `${C.green}$${(amountUSD / 1_000_000).toFixed(1)}M${C.reset}  ${C.dim}(${amountUSD.toLocaleString()} USD)${C.reset}`
        : `${C.yellow}none${C.reset}  ${C.dim}(no dollar figure in tweet text)${C.reset}`);

  row('Passes $1M threshold:',
      amountUSD === null
        ? warn('no amount → would be dropped in production')
        : passesAmount
          ? pass(`≥ $${(FUNDING_THRESHOLD_USD / 1_000_000).toFixed(0)}M floor`)
          : fail(`below $${(FUNDING_THRESHOLD_USD / 1_000_000).toFixed(0)}M floor`));

  if (vcPortfolioName) {
    row('Extracted company name:',
        `${C.green}"${vcPortfolioName}"${C.reset}`);
    if (vcPortfolioName.toLowerCase().includes('part ii') || vcPortfolioName.toLowerCase().includes('part i')) {
      console.log(`  ${C.dim}  ↳ note: blog-post suffix ("Part II") included — production would use resolver name${C.reset}`);
    }
  }

  console.log();
  const allPass = passesGate && passesAmount;
  const verdict = allPass
    ? `${C.bold}${C.green}  ✓  WOULD BE QUEUED${C.reset}`
    : passesGate
      ? `${C.bold}${C.yellow}  ⚠  GATE PASSES — dropped only by amount check${C.reset}`
      : `${C.bold}${C.red}  ✗  WOULD BE DROPPED${C.reset}`;
  console.log(verdict);
}

// ── Run ───────────────────────────────────────────────────────────────────────

console.log(`\n${C.bold}X-Radar Filter Chain — Smoke Test${C.reset}`);
console.log(`${C.dim}Trusted VCs loaded: ${TRUSTED_CRYPTO_VCS.length} entries${C.reset}`);

MOCK_TWEETS.forEach(evaluate);

console.log(`\n${'─'.repeat(66)}\n`);
