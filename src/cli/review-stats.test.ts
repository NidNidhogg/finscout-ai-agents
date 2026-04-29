import { formatStats } from './review-stats';
import type { ReviewQueueStats } from '../review-queue/types';

function makeStats(overrides: Partial<ReviewQueueStats> = {}): ReviewQueueStats {
  return {
    pendingCount: 3,
    reviewedCount: 10,
    droppedCount: 1,
    dod: {
      totalReviewed: 10,
      adequacyRate: 0.8,
      adequacyRatePct: 80,
      isVolumeThresholdMet: false,
      isAdequacyThresholdMet: true,
      missingEvidenceDistribution: {
        missing_tech_stack: 1,
        missing_traction_signal: 0,
        missing_founder_context: 0,
        missing_architecture_signal: 0,
        noise_false_positive: 1,
      },
      dominantFailureModeExceeds40Pct: false,
      isDoDMet: false,
      tierDistribution: { A: 4, B: 4, C: 2 },
      leadTimeDays: { median: null, values: [] },
    },
    ...overrides,
  };
}

describe('formatStats', () => {
  it('shows pending, reviewed, and dropped counts', () => {
    const output = formatStats(makeStats());
    expect(output).toContain('Pending:  3');
    expect(output).toContain('Reviewed: 10');
    expect(output).toContain('Dropped:  1');
  });

  it('shows total reviewed and adequacy rate', () => {
    const output = formatStats(makeStats());
    expect(output).toContain('10');
    expect(output).toContain('80.0%');
  });

  it('shows DoD NOT met when volume threshold unmet', () => {
    const output = formatStats(makeStats());
    expect(output).toContain('NO');
  });

  it('shows DoD met when all thresholds pass', () => {
    const stats = makeStats({
      dod: {
        totalReviewed: 25,
        adequacyRate: 0.85,
        adequacyRatePct: 85,
        isVolumeThresholdMet: true,
        isAdequacyThresholdMet: true,
        missingEvidenceDistribution: {
          missing_tech_stack: 0,
          missing_traction_signal: 0,
          missing_founder_context: 0,
          missing_architecture_signal: 0,
          noise_false_positive: 0,
        },
        dominantFailureModeExceeds40Pct: false,
        isDoDMet: true,
        tierDistribution: { A: 20, B: 4, C: 1 },
        leadTimeDays: { median: 14, values: [14] },
      },
    });
    const output = formatStats(stats);
    expect(output).toContain('YES');
  });

  it('shows tier distribution', () => {
    const output = formatStats(makeStats());
    expect(output).toContain('A: 4');
    expect(output).toContain('B: 4');
    expect(output).toContain('C: 2');
  });

  it('shows lead time median when present', () => {
    const stats = makeStats({
      dod: {
        ...makeStats().dod,
        leadTimeDays: { median: 7, values: [7] },
      },
    });
    const output = formatStats(stats);
    expect(output).toContain('7 days');
  });

  it('omits lead time section when median is null', () => {
    const output = formatStats(makeStats());
    expect(output).not.toContain('Lead time');
  });
});
