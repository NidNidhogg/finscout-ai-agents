import type { EnrichedProfile, MissingEvidenceType, ReviewAnnotation } from '../schema/enrichedProfile';

export interface ReviewedRecord {
  profile: EnrichedProfile;
  annotation: ReviewAnnotation;
}

export interface DoDMetrics {
  totalReviewed: number;
  adequacyRate: number;
  adequacyRatePct: number;
  isVolumeThresholdMet: boolean;
  isAdequacyThresholdMet: boolean;
  missingEvidenceDistribution: Record<MissingEvidenceType, number>;
  dominantFailureModeExceeds40Pct: boolean;
  isDoDMet: boolean;
  tierDistribution: Record<'A' | 'B' | 'C', number>;
  leadTimeDays: { median: number | null; values: number[] };
}

export interface ReviewQueueStats {
  pendingCount: number;
  reviewedCount: number;
  droppedCount: number;
  dod: DoDMetrics;
}

export type QueueItemStatus = 'pending' | 'reviewed' | 'dropped';

export interface QueueItem {
  id: string;
  profile: EnrichedProfile;
  status: QueueItemStatus;
  enqueuedAt: string;
  reviewedAt?: string;
  annotation?: ReviewAnnotation;
}
