import { randomUUID } from 'crypto';
import { calculateDoDMetrics } from './DoDMetrics';
import {
  makeReviewedRecord,
  makeInadequateReviewedRecord,
} from './__fixtures__/factories';

describe('calculateDoDMetrics()', () => {
  describe('AC-012: empty input', () => {
    it('returns all-zero counts and isDoDMet=false', () => {
      const metrics = calculateDoDMetrics([]);
      expect(metrics.totalReviewed).toBe(0);
      expect(metrics.adequacyRate).toBe(0);
      expect(metrics.adequacyRatePct).toBe(0);
      expect(metrics.isDoDMet).toBe(false);
      expect(metrics.leadTimeDays).toEqual({ median: null, values: [] });
      expect(metrics.missingEvidenceDistribution.missing_tech_stack).toBe(0);
      expect(metrics.missingEvidenceDistribution.missing_traction_signal).toBe(0);
      expect(metrics.missingEvidenceDistribution.missing_founder_context).toBe(0);
      expect(metrics.missingEvidenceDistribution.missing_architecture_signal).toBe(0);
      expect(metrics.missingEvidenceDistribution.noise_false_positive).toBe(0);
    });
  });

  describe('AC-013: adequacyRate calculation', () => {
    it('is 1.0 when all profiles are adequate', () => {
      const records = [randomUUID(), randomUUID(), randomUUID()].map((id) => makeReviewedRecord(id));
      const metrics = calculateDoDMetrics(records);
      expect(metrics.adequacyRate).toBe(1);
      expect(metrics.adequacyRatePct).toBe(100);
    });

    it('is 0.5 when half are adequate', () => {
      const records = [
        makeReviewedRecord(randomUUID()),
        makeInadequateReviewedRecord(randomUUID()),
      ];
      const metrics = calculateDoDMetrics(records);
      expect(metrics.adequacyRate).toBe(0.5);
      expect(metrics.adequacyRatePct).toBe(50);
    });

    it('is 0 when totalReviewed is 0', () => {
      expect(calculateDoDMetrics([]).adequacyRate).toBe(0);
    });
  });

  describe('AC-014: volume and adequacy threshold flags', () => {
    it('isVolumeThresholdMet is false when totalReviewed < 25', () => {
      const records = Array.from({ length: 10 }, () => makeReviewedRecord());
      expect(calculateDoDMetrics(records).isVolumeThresholdMet).toBe(false);
    });

    it('isVolumeThresholdMet is true when totalReviewed >= 25', () => {
      const records = Array.from({ length: 25 }, () => makeReviewedRecord());
      expect(calculateDoDMetrics(records).isVolumeThresholdMet).toBe(true);
    });

    it('isAdequacyThresholdMet is false when adequacyRate < 0.80', () => {
      const records = [makeReviewedRecord(), makeInadequateReviewedRecord()];
      expect(calculateDoDMetrics(records).isAdequacyThresholdMet).toBe(false);
    });

    it('isAdequacyThresholdMet is true when adequacyRate >= 0.80 (4 adequate, 1 inadequate)', () => {
      const records = [
        ...Array.from({ length: 4 }, () => makeReviewedRecord()),
        makeInadequateReviewedRecord(),
      ];
      expect(calculateDoDMetrics(records).isAdequacyThresholdMet).toBe(true);
    });
  });

  describe('AC-015: isDoDMet requires all three conditions', () => {
    it('is false when volume < 25 even if adequacy >= 0.80', () => {
      const records = Array.from({ length: 10 }, () => makeReviewedRecord());
      expect(calculateDoDMetrics(records).isDoDMet).toBe(false);
    });

    it('is false when adequacy < 0.80 even if volume >= 25', () => {
      const records = [
        ...Array.from({ length: 10 }, () => makeReviewedRecord()),
        ...Array.from({ length: 15 }, () => makeInadequateReviewedRecord()),
      ];
      expect(calculateDoDMetrics(records).isDoDMet).toBe(false);
    });

    it('is false when dominant failure mode exceeds 40% even if other conditions are met', () => {
      const records = [
        ...Array.from({ length: 20 }, () => makeReviewedRecord()),
        ...Array.from({ length: 3 }, () =>
          makeInadequateReviewedRecord(undefined, { missingEvidenceTypes: ['missing_tech_stack'] }),
        ),
        ...Array.from({ length: 2 }, () =>
          makeInadequateReviewedRecord(undefined, { missingEvidenceTypes: ['missing_founder_context'] }),
        ),
      ];
      const metrics = calculateDoDMetrics(records);
      expect(metrics.isVolumeThresholdMet).toBe(true);
      expect(metrics.isAdequacyThresholdMet).toBe(true);
      expect(metrics.dominantFailureModeExceeds40Pct).toBe(true);
      expect(metrics.isDoDMet).toBe(false);
    });

    it('is true when all three conditions are simultaneously met', () => {
      const records = [
        ...Array.from({ length: 22 }, () => makeReviewedRecord()),
        makeInadequateReviewedRecord(undefined, { missingEvidenceTypes: ['missing_tech_stack'] }),
        makeInadequateReviewedRecord(undefined, { missingEvidenceTypes: ['missing_founder_context'] }),
        makeInadequateReviewedRecord(undefined, { missingEvidenceTypes: ['missing_architecture_signal'] }),
      ];
      expect(calculateDoDMetrics(records).isDoDMet).toBe(true);
    });
  });

  describe('AC-016: missingEvidenceDistribution', () => {
    it('counts each type across inadequate records only', () => {
      const records = [
        makeReviewedRecord(),
        makeInadequateReviewedRecord(undefined, { missingEvidenceTypes: ['missing_tech_stack'] }),
        makeInadequateReviewedRecord(undefined, {
          missingEvidenceTypes: ['missing_tech_stack', 'missing_founder_context'],
        }),
      ];
      const metrics = calculateDoDMetrics(records);
      expect(metrics.missingEvidenceDistribution.missing_tech_stack).toBe(2);
      expect(metrics.missingEvidenceDistribution.missing_founder_context).toBe(1);
      expect(metrics.missingEvidenceDistribution.missing_architecture_signal).toBe(0);
    });

    it('always includes all five enum keys', () => {
      const metrics = calculateDoDMetrics([makeReviewedRecord()]);
      const keys = Object.keys(metrics.missingEvidenceDistribution);
      expect(keys).toContain('missing_tech_stack');
      expect(keys).toContain('missing_traction_signal');
      expect(keys).toContain('missing_founder_context');
      expect(keys).toContain('missing_architecture_signal');
      expect(keys).toContain('noise_false_positive');
    });
  });

  describe('AC-017: dominantFailureModeExceeds40Pct', () => {
    it('is false when there are zero inadequate records', () => {
      const records = [makeReviewedRecord(), makeReviewedRecord()];
      expect(calculateDoDMetrics(records).dominantFailureModeExceeds40Pct).toBe(false);
    });

    it('is false when no single type exceeds 40% of inadequate count', () => {
      const records = [
        makeInadequateReviewedRecord(undefined, { missingEvidenceTypes: ['missing_tech_stack'] }),
        makeInadequateReviewedRecord(undefined, { missingEvidenceTypes: ['missing_founder_context'] }),
        makeInadequateReviewedRecord(undefined, { missingEvidenceTypes: ['missing_architecture_signal'] }),
      ];
      expect(calculateDoDMetrics(records).dominantFailureModeExceeds40Pct).toBe(false);
    });

    it('is true when one type appears in more than 40% of inadequate records', () => {
      const records = [
        ...Array.from({ length: 3 }, () =>
          makeInadequateReviewedRecord(undefined, { missingEvidenceTypes: ['missing_tech_stack'] }),
        ),
        ...Array.from({ length: 2 }, () =>
          makeInadequateReviewedRecord(undefined, { missingEvidenceTypes: ['noise_false_positive'] }),
        ),
      ];
      expect(calculateDoDMetrics(records).dominantFailureModeExceeds40Pct).toBe(true);
    });
  });

  describe('AC-018: tierDistribution', () => {
    it('counts A/B/C tiers across all reviewed records', () => {
      const records = [
        makeReviewedRecord(undefined, { tier: 'A' }),
        makeReviewedRecord(undefined, { tier: 'A' }),
        makeReviewedRecord(undefined, { tier: 'B' }),
        makeInadequateReviewedRecord(undefined, { tier: 'C' }),
      ];
      const metrics = calculateDoDMetrics(records);
      expect(metrics.tierDistribution.A).toBe(2);
      expect(metrics.tierDistribution.B).toBe(1);
      expect(metrics.tierDistribution.C).toBe(1);
    });

    it('all three tier keys always present', () => {
      const metrics = calculateDoDMetrics([makeReviewedRecord(undefined, { tier: 'A' })]);
      expect(metrics.tierDistribution).toHaveProperty('A');
      expect(metrics.tierDistribution).toHaveProperty('B');
      expect(metrics.tierDistribution).toHaveProperty('C');
    });
  });
});
