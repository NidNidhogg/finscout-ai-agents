import { writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import Database from 'better-sqlite3';
import { createReviewQueue } from '../review-queue/ReviewQueue';
import type { QueueItem } from '../review-queue/types';

export interface ExportRecord {
  id: string;
  enqueuedAt: string;
  reviewedAt?: string;
  company: string;
  websiteUrl: string;
  tier: string;
  profileAdequate: boolean;
  missingEvidenceTypes: string[];
  tierReason: string;
  reviewerNote?: string;
}

export function formatExportRecord(item: QueueItem): ExportRecord {
  const annotation = item.annotation!;
  return {
    id: item.id,
    enqueuedAt: item.enqueuedAt,
    reviewedAt: item.reviewedAt,
    company: item.profile.company.name,
    websiteUrl: item.profile.company.websiteUrl,
    tier: annotation.tier,
    profileAdequate: annotation.profileAdequate,
    missingEvidenceTypes: annotation.missingEvidenceTypes,
    tierReason: annotation.tierReason,
    reviewerNote: annotation.reviewerNote,
  };
}

async function main(): Promise<void> {
  const dbPath = process.env['REVIEW_DB_PATH'] ?? 'data/review-queue.db';
  const outputPath =
    process.env['EXPORT_PATH'] ??
    `data/exports/reviewed-${new Date().toISOString().slice(0, 10)}.json`;

  const db = new Database(dbPath);
  const queue = createReviewQueue({ db });

  const reviewed = await queue.exportReviewed();
  const records = reviewed.map(formatExportRecord);

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(records, null, 2), 'utf-8');

  console.log(`[review-export] Exported ${records.length} records to ${outputPath}`);
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error('[review-export] Fatal error:', err);
    process.exit(1);
  });
}
