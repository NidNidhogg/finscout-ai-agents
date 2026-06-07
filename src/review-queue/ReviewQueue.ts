import type Database from 'better-sqlite3';
import { EnrichedProfileSchema, ReviewAnnotationSchema } from '../schema/enrichedProfile';
import type { EnrichedProfile, ReviewAnnotation } from '../schema/enrichedProfile';
import { calculateDoDMetrics } from './DoDMetrics';
import {
  NotFoundError,
  AlreadyReviewedError,
  AnnotationMismatchError,
} from './errors';
import type { QueueItem, ReviewQueueStats, ReviewedRecord } from './types';

interface Row {
  id: string;
  profile_json: string;
  status: string;
  enqueued_at: string;
  reviewed_at: string | null;
  annotation_json: string | null;
}

export function createReviewQueue({ db }: { db: Database.Database }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS queue_items (
      id            TEXT PRIMARY KEY,
      profile_json  TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      enqueued_at   TEXT NOT NULL,
      reviewed_at   TEXT,
      annotation_json TEXT
    )
  `);

  function rowToItem(row: Row): QueueItem {
    return {
      id: row.id,
      profile: JSON.parse(row.profile_json) as EnrichedProfile,
      status: row.status as QueueItem['status'],
      enqueuedAt: row.enqueued_at,
      reviewedAt: row.reviewed_at ?? undefined,
      annotation: row.annotation_json
        ? (JSON.parse(row.annotation_json) as ReviewAnnotation)
        : undefined,
    };
  }

  async function push(profile: EnrichedProfile): Promise<void> {
    EnrichedProfileSchema.parse(profile);
    db.prepare(
      `INSERT OR IGNORE INTO queue_items (id, profile_json, status, enqueued_at)
       VALUES (?, ?, 'pending', ?)`,
    ).run(profile.id, JSON.stringify(profile), new Date().toISOString());
  }

  async function listPending(): Promise<QueueItem[]> {
    const rows = db
      .prepare(`SELECT * FROM queue_items WHERE status = 'pending' ORDER BY enqueued_at ASC`)
      .all() as Row[];
    return rows.map(rowToItem);
  }

  async function get(id: string): Promise<QueueItem | undefined> {
    const row = db.prepare(`SELECT * FROM queue_items WHERE id = ?`).get(id) as Row | undefined;
    return row ? rowToItem(row) : undefined;
  }

  async function submitReview(id: string, annotation: ReviewAnnotation): Promise<void> {
    if ((annotation as { profileId?: string }).profileId !== id) {
      throw new AnnotationMismatchError(id, (annotation as { profileId?: string }).profileId ?? '');
    }

    ReviewAnnotationSchema.parse(annotation);

    db.transaction(() => {
      const row = db.prepare(`SELECT * FROM queue_items WHERE id = ?`).get(id) as Row | undefined;
      if (!row) {
        throw new NotFoundError(id);
      }
      if (row.status === 'reviewed') {
        throw new AlreadyReviewedError(id);
      }
      db.prepare(
        `UPDATE queue_items SET status = 'reviewed', reviewed_at = ?, annotation_json = ? WHERE id = ?`,
      ).run(new Date().toISOString(), JSON.stringify(annotation), id);
    })();
  }

  async function drop(id: string): Promise<void> {
    db.transaction(() => {
      const row = db.prepare(`SELECT * FROM queue_items WHERE id = ?`).get(id) as Row | undefined;
      if (!row) {
        throw new NotFoundError(id);
      }
      if (row.status === 'reviewed') {
        throw new AlreadyReviewedError(id);
      }
      db.prepare(`UPDATE queue_items SET status = 'dropped' WHERE id = ?`).run(id);
    })();
  }

  async function exportReviewed(): Promise<QueueItem[]> {
    const rows = db
      .prepare(`SELECT * FROM queue_items WHERE status = 'reviewed'`)
      .all() as Row[];
    return rows.map(rowToItem);
  }

  async function getStats(): Promise<ReviewQueueStats> {
    const counts = db
      .prepare(
        `SELECT status, COUNT(*) as cnt FROM queue_items GROUP BY status`,
      )
      .all() as Array<{ status: string; cnt: number }>;

    const countMap = Object.fromEntries(counts.map((r) => [r.status, r.cnt]));

    const reviewedRows = db
      .prepare(`SELECT * FROM queue_items WHERE status = 'reviewed'`)
      .all() as Row[];

    const reviewedRecords: ReviewedRecord[] = reviewedRows
      .filter((r) => r.annotation_json !== null)
      .map((r) => ({
        profile: JSON.parse(r.profile_json) as EnrichedProfile,
        annotation: JSON.parse(r.annotation_json!) as ReviewAnnotation,
      }));

    return {
      pendingCount: countMap['pending'] ?? 0,
      reviewedCount: countMap['reviewed'] ?? 0,
      droppedCount: countMap['dropped'] ?? 0,
      needsRetryCount: countMap['needs_retry'] ?? 0,
      dod: calculateDoDMetrics(reviewedRecords),
    };
  }

  return { push, listPending, get, submitReview, drop, exportReviewed, getStats };
}
