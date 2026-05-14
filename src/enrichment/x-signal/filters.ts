import type { Signal } from '../../fingerprint/schemas';

export const FUNDING_SIGNAL_PHRASES: string[] = [
  'raised seed',
  'raised $',
  'seed round',
  'thrilled to announce',
  'excited to share',
  'just closed',
  'we raised',
  'new funding',
  'proud to announce',
  'announcing our',
  'closed our round',
  'in funding',
  'm raised',
  'k raised',
  'pre-seed',
  'series a',
  'funding round',
  'investment round',
  'strategic round',
];

export function matchesTemplates(text: string): string[] {
  const lower = text.toLowerCase();
  return FUNDING_SIGNAL_PHRASES.filter((phrase) => lower.includes(phrase));
}

export function detectAntiVocab(
  text: string,
  bio: string | undefined,
  antiSignals: Signal[],
): string | null {
  const lowerText = text.toLowerCase();
  const lowerBio = bio?.toLowerCase();
  for (const signal of antiSignals) {
    const term = signal.term.toLowerCase();
    if (lowerText.includes(term)) return signal.term;
    if (lowerBio !== undefined && lowerBio.includes(term)) return signal.term;
  }
  return null;
}

// Matches $Xk / $XM / $XB (dollar sign required; \b prevents "m" matching "million")
const ABBREVIATED_AMOUNT_RE = /\$\s*(\d+(?:\.\d+)?)\s*(k|m|b)\b/i;
// Matches X million / X billion / X thousand (dollar sign optional)
const WORD_AMOUNT_RE = /\$?\s*(\d+(?:\.\d+)?)\s*(million|billion|thousand)\b/i;

export function extractFundingAmountUSD(text: string): number | null {
  let match = ABBREVIATED_AMOUNT_RE.exec(text);
  if (match) {
    const value = parseFloat(match[1]);
    const unit = match[2].toLowerCase();
    if (unit === 'k') return value * 1_000;
    if (unit === 'm') return value * 1_000_000;
    if (unit === 'b') return value * 1_000_000_000;
  }
  match = WORD_AMOUNT_RE.exec(text);
  if (match) {
    const value = parseFloat(match[1]);
    const unit = match[2].toLowerCase();
    if (unit === 'thousand') return value * 1_000;
    if (unit === 'million') return value * 1_000_000;
    if (unit === 'billion') return value * 1_000_000_000;
  }
  return null;
}

export function isBelowFundingThreshold(text: string, thresholdUSD: number): boolean {
  const amount = extractFundingAmountUSD(text);
  return amount !== null && amount < thresholdUSD;
}

export function matchPrimarySignals(
  text: string,
  bio: string | undefined,
  primarySignals: Signal[],
): string[] {
  const lowerText = text.toLowerCase();
  const lowerBio = bio?.toLowerCase();
  return primarySignals
    .filter((signal) => {
      const term = signal.term.toLowerCase();
      return lowerText.includes(term) || (lowerBio !== undefined && lowerBio.includes(term));
    })
    .map((signal) => signal.term);
}
