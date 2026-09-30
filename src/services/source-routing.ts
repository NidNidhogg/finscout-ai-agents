/**
 * source-routing.ts — lead-source detection and prompt routing.
 *
 * Shared by generate-outreach.ts (production pipeline) and evals/run-evals.ts
 * (eval contour), so evals exercise the exact routing the pipeline uses.
 */

import type { EnrichedProfile } from '../schema/enrichedProfile';

export type LeadSource = 'cryptorank' | 'funding-radar' | 'x-radar' | 'defillama' | 'unknown';

export function detectSource(profile: EnrichedProfile): LeadSource {
  const rawText = profile.funding.claimed?.rawText ?? '';
  if (rawText.startsWith('CryptoRank:')) return 'cryptorank';
  if (rawText.startsWith('Funding Radar:')) return 'funding-radar';
  if (rawText.startsWith('X-Radar:')) return 'x-radar';
  if (rawText.startsWith('DefiLlama TVL:')) return 'defillama';
  return 'unknown';
}

export const SOURCE_ANGLE: Record<LeadSource, string> = {
  cryptorank:      'CryptoRank Funding Radar — recent raise (MVA / post-raise technical debt prevention)',
  'funding-radar': 'DefiLlama Raises — recently funded Web3 project (MVA / post-raise technical debt prevention)',
  'x-radar':       'X Funding Radar — announced raise detected via Twitter/X (MVA / post-raise technical debt prevention)',
  defillama:       'DefiLlama — live on-chain protocol (Zero-Trust, HSM, high-load security)',
  unknown:         'direct / manual injection',
};

export const FRAMEWORK_BY_SOURCE: Record<LeadSource, { hypothesis: string; valueDrop: string }> = {
  'x-radar': {
    hypothesis:
      'Name a precise architectural risk implied by their stack and raise stage. ' +
      'Focus on post-raise technical debt traps: premature abstractions locked in at MVP phase, ' +
      'synchronous bottlenecks that survive into production, missing observability at persistence ' +
      'boundaries, or auth/key management shortcuts that compound into security liabilities at scale.',
    valueDrop:
      'One sentence on how iDECP\'s MVA approach eliminates this. ' +
      'Angle: a 6–12 week Minimum Viable Architecture engagement avoids the ' +
      '"quick and dirty" trap — the architectural choices made in weeks 1–4 post-raise that cause ' +
      '70% of teams to hit a hard scaling wall at 12 months. 40% less technical debt, no throwaway code.',
  },
  'funding-radar': {
    hypothesis:
      'Name a precise architectural risk implied by their stack and raise stage. ' +
      'Focus on post-raise technical debt traps: premature abstractions locked in at MVP phase, ' +
      'synchronous bottlenecks that survive into production, missing observability at persistence ' +
      'boundaries, or auth/key management shortcuts that compound into security liabilities at scale.',
    valueDrop:
      'One sentence on how iDECP\'s MVA approach eliminates this. ' +
      'Angle: a 6–12 week Minimum Viable Architecture engagement avoids the ' +
      '"quick and dirty" trap — the architectural choices made in weeks 1–4 post-raise that cause ' +
      '70% of teams to hit a hard scaling wall at 12 months. 40% less technical debt, no throwaway code.',
  },
  cryptorank: {
    hypothesis:
      'Name a precise architectural risk implied by their stack and raise stage. ' +
      'Focus on post-raise technical debt traps: premature abstractions locked in at MVP phase, ' +
      'synchronous bottlenecks that survive into production, missing observability at persistence ' +
      'boundaries, or auth/key management shortcuts that compound into security liabilities at scale.',
    valueDrop:
      'One sentence on how iDECP\'s MVA approach eliminates this. ' +
      'Angle: a 6–12 week Minimum Viable Architecture engagement avoids the ' +
      '"quick and dirty" trap — the architectural choices made in weeks 1–4 post-raise that cause ' +
      '70% of teams to hit a hard scaling wall at 12 months. 40% less technical debt, no throwaway code.',
  },
  defillama: {
    hypothesis:
      'Name a precise architectural, scaling, or security challenge implied by their signals ' +
      '(e.g., multi-sig coordination under load, settlement finality risk under adversarial conditions, ' +
      'key management at HSM tier, intent-relay latency).',
    valueDrop:
      'One sentence on how iDECP addresses this. ' +
      'Choose the angle that fits: Zero-Trust backends, MVA for high-load async systems, ' +
      'cross-chain security primitives, or HSM-grade key management.',
  },
  unknown: {
    hypothesis:
      'Name a precise architectural, scaling, or security challenge implied by their signals ' +
      '(e.g., multi-sig coordination under load, settlement finality risk under adversarial conditions, ' +
      'key management at HSM tier, intent-relay latency).',
    valueDrop:
      'One sentence on how iDECP addresses this. ' +
      'Choose the angle that fits: Minimum Viable Architecture, Zero-Trust backends, ' +
      'cross-chain security primitives, high-load async systems, or HSM-grade key management.',
  },
};
