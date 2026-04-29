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
