import { createReviewQueue } from './ReviewQueue';
import { AlreadyReviewedError, AnnotationMismatchError, NotFoundError } from './errors';
import {
  makeProfile,
  makeAnnotation,
  makeInadequateAnnotation,
  makeInMemoryDb,
} from './__fixtures__/factories';

// ── AC-001: table created on construction ─────────────────────────────────────

describe('createReviewQueue', () => {
  it('AC-001: creates the queue_items table on construction', () => {
    const db = makeInMemoryDb();
    createReviewQueue({ db });
    const result = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='queue_items'")
      .get();
    expect(result).toBeDefined();
  });
});

// ── AC-002 to AC-004: push() ──────────────────────────────────────────────────

describe('ReviewQueue.push()', () => {
  let queue: ReturnType<typeof createReviewQueue>;

  beforeEach(() => {
    queue = createReviewQueue({ db: makeInMemoryDb() });
  });

  it('AC-002: throws when profile fails schema validation', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    expect(pending.filter((i) => i.id === profile.id)).toHaveLength(1);
  });
});

// ── AC-005: listPending() ─────────────────────────────────────────────────────

describe('ReviewQueue.listPending()', () => {
  it('AC-005: returns only pending items ordered by enqueuedAt ascending', async () => {
    const queue = createReviewQueue({ db: makeInMemoryDb() });
    const p1 = makeProfile();
    const p2 = makeProfile();
    const p3 = makeProfile();
    await queue.push(p1);
    await queue.push(p2);
    await queue.push(p3);
    await queue.submitReview(p2.id, makeAnnotation(p2.id));
    const pending = await queue.listPending();
    expect(pending.every((i) => i.status === 'pending')).toBe(true);
    expect(pending.map((i) => i.id)).not.toContain(p2.id);
    const timestamps = pending.map((i) => i.enqueuedAt);
    expect(timestamps).toEqual([...timestamps].sort());
  });
});

// ── AC-006: get() ─────────────────────────────────────────────────────────────

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

// ── AC-007 to AC-011: submitReview() ─────────────────────────────────────────

describe('ReviewQueue.submitReview()', () => {
  let queue: ReturnType<typeof createReviewQueue>;
  let profile: ReturnType<typeof makeProfile>;

  beforeEach(async () => {
    queue = createReviewQueue({ db: makeInMemoryDb() });
    profile = makeProfile();
    await queue.push(profile);
  });

  it('AC-007: throws when annotation fails schema validation', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(queue.submitReview(profile.id, { profileId: profile.id } as any)).rejects.toThrow();
  });

  it('AC-007: throws when profileAdequate=false with empty missingEvidenceTypes', async () => {
    const bad = makeAnnotation(profile.id, { profileAdequate: false, missingEvidenceTypes: [] });
    await expect(queue.submitReview(profile.id, bad)).rejects.toThrow();
  });

  it('AC-008: transitions status to reviewed, writes reviewedAt + annotation', async () => {
    await queue.submitReview(profile.id, makeAnnotation(profile.id));
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

  it('AC-008 (dropped repair): dropped item can be submitted', async () => {
    await queue.drop(profile.id);
    await expect(queue.submitReview(profile.id, makeAnnotation(profile.id))).resolves.toBeUndefined();
    const item = await queue.get(profile.id);
    expect(item!.status).toBe('reviewed');
  });
});

// ── AC-019: exportReviewed() ─────────────────────────────────────────────────

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

// ── AC-020 to AC-021: drop() ─────────────────────────────────────────────────

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
    expect(pending.map((i) => i.id)).not.toContain(profile.id);
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

// ── AC-022: getStats() ────────────────────────────────────────────────────────

describe('ReviewQueue.getStats()', () => {
  it('AC-022: returns live counts and dod metrics', async () => {
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

  it('AC-022: adequacy rate is correct for mixed adequate/inadequate reviewed items', async () => {
    const queue = createReviewQueue({ db: makeInMemoryDb() });
    const p1 = makeProfile();
    const p2 = makeProfile();
    await queue.push(p1);
    await queue.push(p2);
    await queue.submitReview(p1.id, makeAnnotation(p1.id));
    await queue.submitReview(p2.id, makeInadequateAnnotation(p2.id));

    const stats = await queue.getStats();
    expect(stats.dod.totalReviewed).toBe(2);
    expect(stats.dod.adequacyRate).toBe(0.5);
  });
});
