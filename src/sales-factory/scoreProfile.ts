import type { EnrichedProfile } from '../schema/enrichedProfile';

export type IcpTier = 'A' | 'B' | 'C';

export interface TierResult {
  tier: IcpTier;
  reason: string;
}

const FRESH_DAYS = 120;
const STALE_DAYS = 365;
const MIN_AMOUNT = 1_000_000;
const MAX_AMOUNT = 35_000_000;

export function scoreProfile(profile: EnrichedProfile): TierResult {
  const { antiSignalTerms, stackMentions, architectureTerms } = profile.product;
  const claimed = profile.funding.claimed;
  const rawText = claimed?.rawText ?? '';
  const isDefiLlama = rawText.startsWith('DefiLlama TVL:');

  const hasTechSignals =
    (stackMentions?.length ?? 0) > 0 || (architectureTerms?.length ?? 0) > 0;

  if ((antiSignalTerms?.length ?? 0) > 0) {
    return { tier: 'C', reason: `Anti-signal terms present: ${antiSignalTerms!.join(', ')}` };
  }

  if (!hasTechSignals) {
    return { tier: 'C', reason: 'No technical signals detected (empty stackMentions and architectureTerms)' };
  }

  const amountUSD = claimed?.amountUSD;
  if (amountUSD !== undefined) {
    if (amountUSD < MIN_AMOUNT) {
      return { tier: 'C', reason: `Raise below $1M corridor floor (amount: $${amountUSD.toLocaleString()})` };
    }
    if (amountUSD > MAX_AMOUNT) {
      return { tier: 'C', reason: `Raise above $35M corridor ceiling (amount: $${amountUSD.toLocaleString()})` };
    }
  }

  if (isDefiLlama) {
    return { tier: 'A', reason: 'DefiLlama live on-chain protocol — temporal gate bypassed' };
  }

  const claimedAt = claimed?.claimedAt;
  if (!claimedAt) {
    return { tier: 'B', reason: 'Tech signals present but recency unverifiable (no claimedAt)' };
  }

  const ageMs = Date.now() - new Date(claimedAt).getTime();
  const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1_000));

  if (ageDays > STALE_DAYS) {
    return { tier: 'C', reason: `Raise is stale — ${ageDays} days old (limit: ${STALE_DAYS})` };
  }

  if (ageDays <= FRESH_DAYS) {
    return { tier: 'A', reason: `Fresh raise — ${ageDays} days old (limit: ${FRESH_DAYS})` };
  }

  return { tier: 'B', reason: `Warm raise — ${ageDays} days old (${FRESH_DAYS}–${STALE_DAYS} day window)` };
}
