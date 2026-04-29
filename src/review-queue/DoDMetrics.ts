import type { MissingEvidenceType } from '../schema/enrichedProfile';
import type { DoDMetrics, ReviewedRecord } from './types';

const MISSING_EVIDENCE_TYPES: MissingEvidenceType[] = [
  'missing_tech_stack',
  'missing_traction_signal',
  'missing_founder_context',
  'missing_architecture_signal',
  'noise_false_positive',
];

function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

export function calculateDoDMetrics(records: ReviewedRecord[]): DoDMetrics {
  const totalReviewed = records.length;
  const adequateCount = records.filter((r) => r.annotation.profileAdequate).length;
  const adequacyRate = totalReviewed === 0 ? 0 : adequateCount / totalReviewed;
  const adequacyRatePct = adequacyRate * 100;

  const isVolumeThresholdMet = totalReviewed >= 25;
  const isAdequacyThresholdMet = adequacyRate >= 0.8;

  const inadequateRecords = records.filter((r) => !r.annotation.profileAdequate);
  const inadequateCount = inadequateRecords.length;

  const missingEvidenceDistribution = Object.fromEntries(
    MISSING_EVIDENCE_TYPES.map((t) => [t, 0]),
  ) as Record<MissingEvidenceType, number>;

  for (const record of inadequateRecords) {
    for (const type of record.annotation.missingEvidenceTypes) {
      missingEvidenceDistribution[type]++;
    }
  }

  const dominantFailureModeExceeds40Pct =
    inadequateCount === 0
      ? false
      : Object.values(missingEvidenceDistribution).some((count) => count > inadequateCount * 0.4);

  const isDoDMet =
    isVolumeThresholdMet && isAdequacyThresholdMet && !dominantFailureModeExceeds40Pct;

  const tierDistribution: Record<'A' | 'B' | 'C', number> = { A: 0, B: 0, C: 0 };
  for (const record of records) {
    tierDistribution[record.annotation.tier]++;
  }

  const leadTimeValues: number[] = [];
  for (const record of records) {
    const { crunchbaseCheck } = record.annotation;
    const claimedAt = record.profile.funding.claimed.claimedAt;
    if (
      crunchbaseCheck.foundInCrunchbase === true &&
      crunchbaseCheck.actualDate !== undefined &&
      claimedAt !== undefined
    ) {
      const diffMs =
        new Date(crunchbaseCheck.actualDate).getTime() - new Date(claimedAt).getTime();
      leadTimeValues.push(Math.round(diffMs / (1000 * 60 * 60 * 24)));
    }
  }

  return {
    totalReviewed,
    adequacyRate,
    adequacyRatePct,
    isVolumeThresholdMet,
    isAdequacyThresholdMet,
    missingEvidenceDistribution,
    dominantFailureModeExceeds40Pct,
    isDoDMet,
    tierDistribution,
    leadTimeDays: { median: medianOf(leadTimeValues), values: leadTimeValues },
  };
}
