# TEST SCAFFOLD: Review Queue

## Overview

This scaffold defines the test files, shared factory helpers, and `describe`/`it` stub structure for the Review Queue spec (`specs/review-queue/spec.md`). All test files live under `src/review-queue/`. Tests use Jest with `better-sqlite3` in-memory databases — no disk I/O in any test.

---

## Test Files

| File | ACs Covered | Purpose |
|------|-------------|---------|
| `src/review-queue/ReviewQueue.test.ts` | AC-001–AC-011, AC-019–AC-022 | CRUD, submission, drop, stats, export |
| `src/review-queue/DoDMetrics.test.ts` | AC-012–AC-018 | Pure `calculateDoDMetrics` function |
| `src/review-queue/ReviewQueue.errors.test.ts` | Error class shape | Error hierarchy and property assertions |

---

## Shared Factory Helpers

Place these in `src/review-queue/__fixtures__/factories.ts`.

```typescript
import { v4 as uuidv4 } from 'uuid';
import Database from 'better-sqlite3';
import type { EnrichedProfile, ReviewAnnotation } from '../../schema/enrichedProfile';

// Minimal valid EnrichedProfile. All required fields populated; optional omitted.
export function makeProfile(overrides: Partial<EnrichedProfile> = {}): EnrichedProfile {
  const id = overrides.id ?? uuidv4();
  return {
    id,
    enrichedAt: new Date().toISOString(),
    schemaVersion: '1.0.0',
    sources: {},
    company: {
      name: 'Acme DeFi',
      normalizedName: 'acme defi',
      websiteUrl: 'https://acme.fi',
    },
    funding: {
      claimed: {},
    },
    product: {
      stackMentions: [],
      architectureTerms: [],
      antiSignalTerms: [],
      competencyCellMatches: [],
      evidence: [],
    },
    team: {
      founders: [],
    },
    rawContent: {
      websiteMarkdown: {},
    },
    ...overrides,
  };
}

// Minimal valid ReviewAnnotation with profileAdequate=true.
export function makeAnnotation(
  profileId: string,
  overrides: Partial<ReviewAnnotation> = {},
): ReviewAnnotation {
  return {
    profileId,
    reviewedAt: new Date().toISOString(),
    reviewedBy: 'dmitriy',
    profileAdequate: true,
    missingEvidenceTypes: [],
    tier: 'A',
    tierReason: 'Strong DeFi signals with multi-cell match.',
    crunchbaseCheck: {
      checked: true,
      foundInCrunchbase: false,
    },
    ...overrides,
  };
}

// Annotation for an inadequate profile (must include at least one missingEvidenceType).
export function makeInadequateAnnotation(
  profileId: string,
  overrides: Partial<ReviewAnnotation> = {},
): ReviewAnnotation {
  return makeAnnotation(profileId, {
    profileAdequate: false,
    missingEvidenceTypes: ['missing_tech_stack'],
    tier: 'C',
    tierReason: 'Insufficient product signals.',
    ...overrides,
  });
}

// Opens an isolated in-memory SQLite database for each test.
export function makeInMemoryDb(): Database.Database {
  return new Database(':memory:');
}
```

---

## Test File: `src/review-queue/ReviewQueue.test.ts`

```typescript
import { createReviewQueue } from '../ReviewQueue';
import {
  AlreadyReviewedError,
  AnnotationMismatchError,
  NotFoundError,
} from '../errors';
import {
  makeProfile,
  makeAnnotation,
  makeInadequateAnnotation,
  makeInMemoryDb,
} from './__fixtures__/factories';

describe('createReviewQueue', () => {
  it('AC-001: creates the queue_items table on construction', async () => {
    const db = makeInMemoryDb();
    createReviewQueue({ db });
    const result = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='queue_items'")
      .get();
    expect(result).toBeDefined();
  });
});

describe('ReviewQueue.push()', () => {
  let queue: ReturnType<typeof createReviewQueue>;

  beforeEach(() => {
    queue = createReviewQueue({ db: makeInMemoryDb() });
  });

  it('AC-002: throws ZodError when profile fails schema validation', async () => {
    await expect(queue.push({ id: 'not-a-uuid' } as any)).rejects.toThrow();
  });

  it('AC-003: persists a valid profile with status=pending and enqueuedAt', async () => {
    const profile = makeProfile();
    await queue.push(profile);
    const item = await queue.get(profile.id);
    expect(item).toBeDefined();
    expect(item!.status).toBe('pending');
    expect(item!.enqueuedAt).toBeTruthy();
    expect(item!.profile.id).toBe(profile.id);
  });

  it('AC-004: is idempotent — second push with same id produces no error and no duplicate', async () => {
    const profile = makeProfile();
    await queue.push(profile);
    await expect(queue.push(profile)).resolves.toBeUndefined();
    const pending = await queue.listPending();
    expect(pending.filter(i => i.id === profile.id)).toHaveLength(1);
  });
});

describe('ReviewQueue.listPending()', () => {
  it('AC-005: returns only pending items ordered by enqueuedAt ascending', async () => {
    const queue = createReviewQueue({ db: makeInMemoryDb() });
    const p1 = makeProfile();
    const p2 = makeProfile();
    const p3 = makeProfile();
    await queue.push(p1);
    await queue.push(p2);
    await queue.push(p3);
    // review p2 so it no longer appears
    await queue.submitReview(p2.id, makeAnnotation(p2.id));
    const pending = await queue.listPending();
    expect(pending.every(i => i.status === 'pending')).toBe(true);
    expect(pending.map(i => i.id)).not.toContain(p2.id);
    // order by enqueuedAt ascending
    const timestamps = pending.map(i => i.enqueuedAt);
    expect(timestamps).toEqual([...timestamps].sort());
  });
});

describe('ReviewQueue.get()', () => {
  it('AC-006: returns QueueItem with deserialized profile and annotation', async () => {
    const queue = createReviewQueue({ db: makeInMemoryDb() });
    const profile = makeProfile();
    await queue.push(profile);
    const annotation = makeAnnotation(profile.id);
    await queue.submitReview(profile.id, annotation);
    const item = await queue.get(profile.id);
    expect(item).toBeDefined();
    expect(item!.profile.id).toBe(profile.id);
    expect(item!.annotation?.profileId).toBe(profile.id);
  });

  it('AC-006: returns undefined for an unknown id', async () => {
    const queue = createReviewQueue({ db: makeInMemoryDb() });
    const result = await queue.get('00000000-0000-0000-0000-000000000000');
    expect(result).toBeUndefined();
  });
});

describe('ReviewQueue.submitReview()', () => {
  let queue: ReturnType<typeof createReviewQueue>;
  let profile: ReturnType<typeof makeProfile>;

  beforeEach(async () => {
    queue = createReviewQueue({ db: makeInMemoryDb() });
    profile = makeProfile();
    await queue.push(profile);
  });

  it('AC-007: throws ZodError when annotation fails schema validation', async () => {
    await expect(
      queue.submitReview(profile.id, { profileId: profile.id } as any),
    ).rejects.toThrow();
  });

  it('AC-007: throws ZodError when profileAdequate=false with empty missingEvidenceTypes', async () => {
    const badAnnotation = makeAnnotation(profile.id, {
      profileAdequate: false,
      missingEvidenceTypes: [],
    });
    await expect(queue.submitReview(profile.id, badAnnotation)).rejects.toThrow();
  });

  it('AC-008: transitions status to reviewed and writes reviewedAt + annotation', async () => {
    const annotation = makeAnnotation(profile.id);
    await queue.submitReview(profile.id, annotation);
    const item = await queue.get(profile.id);
    expect(item!.status).toBe('reviewed');
    expect(item!.reviewedAt).toBeTruthy();
    expect(item!.annotation?.profileId).toBe(profile.id);
  });

  it('AC-009: throws AlreadyReviewedError when item is already reviewed', async () => {
    await queue.submitReview(profile.id, makeAnnotation(profile.id));
    await expect(
      queue.submitReview(profile.id, makeAnnotation(profile.id)),
    ).rejects.toThrow(AlreadyReviewedError);
  });

  it('AC-010: throws NotFoundError when id has no matching item', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000';
    await expect(
      queue.submitReview(fakeId, makeAnnotation(fakeId)),
    ).rejects.toThrow(NotFoundError);
  });

  it('AC-011: throws AnnotationMismatchError when annotation.profileId !== id', async () => {
    const otherId = '00000000-0000-0000-0000-000000000001';
    await expect(
      queue.submitReview(profile.id, makeAnnotation(otherId)),
    ).rejects.toThrow(AnnotationMismatchError);
  });
});

describe('ReviewQueue.exportReviewed()', () => {
  it('AC-019: returns only reviewed items with full annotations', async () => {
    const queue = createReviewQueue({ db: makeInMemoryDb() });
    const p1 = makeProfile();
    const p2 = makeProfile();
    await queue.push(p1);
    await queue.push(p2);
    await queue.submitReview(p1.id, makeAnnotation(p1.id));
    const exported = await queue.exportReviewed();
    expect(exported).toHaveLength(1);
    expect(exported[0].id).toBe(p1.id);
    expect(exported[0].annotation).toBeDefined();
  });
});

describe('ReviewQueue.drop()', () => {
  let queue: ReturnType<typeof createReviewQueue>;
  let profile: ReturnType<typeof makeProfile>;

  beforeEach(async () => {
    queue = createReviewQueue({ db: makeInMemoryDb() });
    profile = makeProfile();
    await queue.push(profile);
  });

  it('AC-020: transitions item to dropped and removes from listPending()', async () => {
    await queue.drop(profile.id);
    const item = await queue.get(profile.id);
    expect(item!.status).toBe('dropped');
    const pending = await queue.listPending();
    expect(pending.map(i => i.id)).not.toContain(profile.id);
  });

  it('AC-021: throws NotFoundError for an unknown id', async () => {
    await expect(
      queue.drop('00000000-0000-0000-0000-000000000000'),
    ).rejects.toThrow(NotFoundError);
  });

  it('AC-021: throws AlreadyReviewedError when item is reviewed', async () => {
    await queue.submitReview(profile.id, makeAnnotation(profile.id));
    await expect(queue.drop(profile.id)).rejects.toThrow(AlreadyReviewedError);
  });
});

describe('ReviewQueue.getStats()', () => {
  it('AC-022: returns live counts and dod metrics from the DB', async () => {
    const queue = createReviewQueue({ db: makeInMemoryDb() });
    const p1 = makeProfile();
    const p2 = makeProfile();
    const p3 = makeProfile();
    await queue.push(p1);
    await queue.push(p2);
    await queue.push(p3);
    await queue.submitReview(p1.id, makeAnnotation(p1.id));
    await queue.drop(p2.id);

    const stats = await queue.getStats();
    expect(stats.pendingCount).toBe(1);
    expect(stats.reviewedCount).toBe(1);
    expect(stats.droppedCount).toBe(1);
    expect(stats.dod.totalReviewed).toBe(1);
    expect(typeof stats.dod.adequacyRate).toBe('number');
  });

  it('AC-022: dod excludes dropped items from DoD calculations', async () => {
    const queue = createReviewQueue({ db: makeInMemoryDb() });
    const p1 = makeProfile();
    const p2 = makeProfile();
    await queue.push(p1);
    await queue.push(p2);
    await queue.drop(p2.id);

    const stats = await queue.getStats();
    expect(stats.dod.totalReviewed).toBe(0);
  });
});
```

---

## Test File: `src/review-queue/DoDMetrics.test.ts`

```typescript
import { calculateDoDMetrics } from '../DoDMetrics';
import { makeAnnotation, makeInadequateAnnotation, makeProfile } from './__fixtures__/factories';
import { v4 as uuidv4 } from 'uuid';

describe('calculateDoDMetrics()', () => {
  describe('AC-012: empty input', () => {
    it('returns all-zero counts and isDoDMet=false', () => {
      const metrics = calculateDoDMetrics([]);
      expect(metrics.totalReviewed).toBe(0);
      expect(metrics.adequacyRate).toBe(0);
      expect(metrics.adequacyRatePct).toBe(0);
      expect(metrics.isDoDMet).toBe(false);
      expect(metrics.leadTimeDays).toEqual({ median: null, values: [] });
      // All five MissingEvidenceType keys present with count 0
      expect(metrics.missingEvidenceDistribution.missing_tech_stack).toBe(0);
      expect(metrics.missingEvidenceDistribution.missing_traction_signal).toBe(0);
      expect(metrics.missingEvidenceDistribution.missing_founder_context).toBe(0);
      expect(metrics.missingEvidenceDistribution.missing_architecture_signal).toBe(0);
      expect(metrics.missingEvidenceDistribution.noise_false_positive).toBe(0);
    });
  });

  describe('AC-013: adequacyRate calculation', () => {
    it('is 1.0 when all profiles are adequate', () => {
      const ids = [uuidv4(), uuidv4(), uuidv4()];
      const annotations = ids.map(id => makeAnnotation(id));
      const metrics = calculateDoDMetrics(annotations);
      expect(metrics.adequacyRate).toBe(1);
      expect(metrics.adequacyRatePct).toBe(100);
    });

    it('is 0.5 when half are adequate', () => {
      const ids = [uuidv4(), uuidv4()];
      const annotations = [
        makeAnnotation(ids[0]),
        makeInadequateAnnotation(ids[1]),
      ];
      const metrics = calculateDoDMetrics(annotations);
      expect(metrics.adequacyRate).toBe(0.5);
      expect(metrics.adequacyRatePct).toBe(50);
    });

    it('is 0 when totalReviewed is 0', () => {
      expect(calculateDoDMetrics([]).adequacyRate).toBe(0);
    });
  });

  describe('AC-014: volume and adequacy threshold flags', () => {
    it('isVolumeThresholdMet is false when totalReviewed < 25', () => {
      const ids = Array.from({ length: 10 }, () => uuidv4());
      const metrics = calculateDoDMetrics(ids.map(id => makeAnnotation(id)));
      expect(metrics.isVolumeThresholdMet).toBe(false);
    });

    it('isVolumeThresholdMet is true when totalReviewed >= 25', () => {
      const ids = Array.from({ length: 25 }, () => uuidv4());
      const metrics = calculateDoDMetrics(ids.map(id => makeAnnotation(id)));
      expect(metrics.isVolumeThresholdMet).toBe(true);
    });

    it('isAdequacyThresholdMet is false when adequacyRate < 0.80', () => {
      const ids = [uuidv4(), uuidv4()];
      const annotations = [makeAnnotation(ids[0]), makeInadequateAnnotation(ids[1])];
      const metrics = calculateDoDMetrics(annotations);
      expect(metrics.isAdequacyThresholdMet).toBe(false);
    });

    it('isAdequacyThresholdMet is true when adequacyRate >= 0.80', () => {
      const ids = Array.from({ length: 5 }, () => uuidv4());
      // 4 adequate, 1 inadequate → 0.8 rate
      const annotations = [
        ...ids.slice(0, 4).map(id => makeAnnotation(id)),
        makeInadequateAnnotation(ids[4]),
      ];
      const metrics = calculateDoDMetrics(annotations);
      expect(metrics.isAdequacyThresholdMet).toBe(true);
    });
  });

  describe('AC-015: isDoDMet requires all three conditions', () => {
    it('is false when volume < 25 even if adequacy >= 0.80', () => {
      const ids = Array.from({ length: 10 }, () => uuidv4());
      const metrics = calculateDoDMetrics(ids.map(id => makeAnnotation(id)));
      expect(metrics.isDoDMet).toBe(false);
    });

    it('is false when adequacy < 0.80 even if volume >= 25', () => {
      const ids = Array.from({ length: 25 }, () => uuidv4());
      // 10 adequate, 15 inadequate → 40% adequate
      const annotations = [
        ...ids.slice(0, 10).map(id => makeAnnotation(id)),
        ...ids.slice(10).map(id => makeInadequateAnnotation(id)),
      ];
      const metrics = calculateDoDMetrics(annotations);
      expect(metrics.isDoDMet).toBe(false);
    });

    it('is false when dominant failure mode exceeds 40% even if other conditions are met', () => {
      // 25 reviewed, 20 adequate (80% rate), 5 inadequate
      // 3 of 5 inadequate are missing_tech_stack → 60% > 40%
      const ids = Array.from({ length: 25 }, () => uuidv4());
      const annotations = [
        ...ids.slice(0, 20).map(id => makeAnnotation(id)),
        ...ids.slice(20, 23).map(id =>
          makeInadequateAnnotation(id, { missingEvidenceTypes: ['missing_tech_stack'] }),
        ),
        ...ids.slice(23).map(id =>
          makeInadequateAnnotation(id, { missingEvidenceTypes: ['missing_founder_context'] }),
        ),
      ];
      const metrics = calculateDoDMetrics(annotations);
      expect(metrics.isVolumeThresholdMet).toBe(true);
      expect(metrics.isAdequacyThresholdMet).toBe(true);
      expect(metrics.dominantFailureModeExceeds40Pct).toBe(true);
      expect(metrics.isDoDMet).toBe(false);
    });

    it('is true when all three conditions are simultaneously met', () => {
      // 25 reviewed, 22 adequate (88%), 3 inadequate spread evenly
      const ids = Array.from({ length: 25 }, () => uuidv4());
      const annotations = [
        ...ids.slice(0, 22).map(id => makeAnnotation(id)),
        makeInadequateAnnotation(ids[22], { missingEvidenceTypes: ['missing_tech_stack'] }),
        makeInadequateAnnotation(ids[23], { missingEvidenceTypes: ['missing_founder_context'] }),
        makeInadequateAnnotation(ids[24], { missingEvidenceTypes: ['missing_architecture_signal'] }),
      ];
      const metrics = calculateDoDMetrics(annotations);
      expect(metrics.isDoDMet).toBe(true);
    });
  });

  describe('AC-016: missingEvidenceDistribution', () => {
    it('counts each type across inadequate profiles only', () => {
      const ids = [uuidv4(), uuidv4(), uuidv4()];
      const annotations = [
        makeAnnotation(ids[0]), // adequate — excluded from distribution
        makeInadequateAnnotation(ids[1], { missingEvidenceTypes: ['missing_tech_stack'] }),
        makeInadequateAnnotation(ids[2], {
          missingEvidenceTypes: ['missing_tech_stack', 'missing_founder_context'],
        }),
      ];
      const metrics = calculateDoDMetrics(annotations);
      expect(metrics.missingEvidenceDistribution.missing_tech_stack).toBe(2);
      expect(metrics.missingEvidenceDistribution.missing_founder_context).toBe(1);
      expect(metrics.missingEvidenceDistribution.missing_architecture_signal).toBe(0);
    });

    it('always includes all five enum keys', () => {
      const metrics = calculateDoDMetrics([makeAnnotation(uuidv4())]);
      const keys = Object.keys(metrics.missingEvidenceDistribution);
      expect(keys).toContain('missing_tech_stack');
      expect(keys).toContain('missing_traction_signal');
      expect(keys).toContain('missing_founder_context');
      expect(keys).toContain('missing_architecture_signal');
      expect(keys).toContain('noise_false_positive');
    });
  });

  describe('AC-017: dominantFailureModeExceeds40Pct', () => {
    it('is false when there are zero inadequate profiles', () => {
      const ids = [uuidv4(), uuidv4()];
      const metrics = calculateDoDMetrics(ids.map(id => makeAnnotation(id)));
      expect(metrics.dominantFailureModeExceeds40Pct).toBe(false);
    });

    it('is false when no single type exceeds 40% of inadequate count', () => {
      // 3 inadequate: each with a different type → 1/3 = 33% each
      const ids = [uuidv4(), uuidv4(), uuidv4()];
      const annotations = [
        makeInadequateAnnotation(ids[0], { missingEvidenceTypes: ['missing_tech_stack'] }),
        makeInadequateAnnotation(ids[1], { missingEvidenceTypes: ['missing_founder_context'] }),
        makeInadequateAnnotation(ids[2], { missingEvidenceTypes: ['missing_architecture_signal'] }),
      ];
      const metrics = calculateDoDMetrics(annotations);
      expect(metrics.dominantFailureModeExceeds40Pct).toBe(false);
    });

    it('is true when one type appears in more than 40% of inadequate profiles', () => {
      // 5 inadequate: 3 with missing_tech_stack → 3/5 = 60% > 40%
      const ids = Array.from({ length: 5 }, () => uuidv4());
      const annotations = [
        ...ids.slice(0, 3).map(id =>
          makeInadequateAnnotation(id, { missingEvidenceTypes: ['missing_tech_stack'] }),
        ),
        ...ids.slice(3).map(id =>
          makeInadequateAnnotation(id, { missingEvidenceTypes: ['noise_false_positive'] }),
        ),
      ];
      const metrics = calculateDoDMetrics(annotations);
      expect(metrics.dominantFailureModeExceeds40Pct).toBe(true);
    });
  });

  describe('AC-018: tierDistribution', () => {
    it('counts A/B/C tiers across all reviewed annotations', () => {
      const ids = [uuidv4(), uuidv4(), uuidv4(), uuidv4()];
      const annotations = [
        makeAnnotation(ids[0], { tier: 'A' }),
        makeAnnotation(ids[1], { tier: 'A' }),
        makeAnnotation(ids[2], { tier: 'B' }),
        makeAnnotation(ids[3], { tier: 'C' }),
      ];
      const metrics = calculateDoDMetrics(annotations);
      expect(metrics.tierDistribution.A).toBe(2);
      expect(metrics.tierDistribution.B).toBe(1);
      expect(metrics.tierDistribution.C).toBe(1);
    });

    it('all three tier keys always present', () => {
      const metrics = calculateDoDMetrics([makeAnnotation(uuidv4(), { tier: 'A' })]);
      expect(metrics.tierDistribution).toHaveProperty('A');
      expect(metrics.tierDistribution).toHaveProperty('B');
      expect(metrics.tierDistribution).toHaveProperty('C');
    });
  });
});
```

---

## Test File: `src/review-queue/ReviewQueue.errors.test.ts`

```typescript
import {
  ReviewQueueError,
  DuplicateProfileError,
  NotFoundError,
  AlreadyReviewedError,
  AnnotationMismatchError,
} from '../errors';

describe('Error class hierarchy', () => {
  it('DuplicateProfileError extends ReviewQueueError', () => {
    const err = new DuplicateProfileError('abc');
    expect(err).toBeInstanceOf(ReviewQueueError);
    expect(err).toBeInstanceOf(DuplicateProfileError);
    expect(err.profileId).toBe('abc');
    expect(err.name).toBe('DuplicateProfileError');
  });

  it('NotFoundError extends ReviewQueueError', () => {
    const err = new NotFoundError('abc');
    expect(err).toBeInstanceOf(ReviewQueueError);
    expect(err.profileId).toBe('abc');
    expect(err.name).toBe('NotFoundError');
  });

  it('AlreadyReviewedError extends ReviewQueueError', () => {
    const err = new AlreadyReviewedError('abc');
    expect(err).toBeInstanceOf(ReviewQueueError);
    expect(err.profileId).toBe('abc');
    expect(err.name).toBe('AlreadyReviewedError');
  });

  it('AnnotationMismatchError extends ReviewQueueError with itemId and annotationProfileId', () => {
    const err = new AnnotationMismatchError('item-1', 'annotation-2');
    expect(err).toBeInstanceOf(ReviewQueueError);
    expect(err.itemId).toBe('item-1');
    expect(err.annotationProfileId).toBe('annotation-2');
    expect(err.name).toBe('AnnotationMismatchError');
  });
});
```

---

## Implementation File Map

When implementing, create these source files under `src/review-queue/`:

| Source File | Exports |
|-------------|---------|
| `errors.ts` | All five error classes |
| `DoDMetrics.ts` | `calculateDoDMetrics`, `DoDMetrics`, `ReviewQueueStats` types |
| `ReviewQueue.ts` | `createReviewQueue`, `ReviewQueue`, `QueueItem`, `QueueItemStatus` types |

The `createReviewQueue` factory depends on `DoDMetrics.ts` (calls `calculateDoDMetrics` inside `getStats()`). The three files can be built and tested in order: errors → DoDMetrics → ReviewQueue.
