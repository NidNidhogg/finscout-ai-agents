import Database from 'better-sqlite3';
import { createReviewQueue } from '../review-queue/ReviewQueue';
import type { ReviewQueueStats } from '../review-queue/types';

function formatPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function formatStats(stats: ReviewQueueStats): string {
  const { pendingCount, reviewedCount, droppedCount, dod } = stats;
  const lines: string[] = [
    '═══════════════════════════════════════════════',
    '  REVIEW QUEUE STATS',
    '═══════════════════════════════════════════════',
    `  Pending:  ${pendingCount}`,
    `  Reviewed: ${reviewedCount}`,
    `  Dropped:  ${droppedCount}`,
    '───────────────────────────────────────────────',
    '  DEFINITION OF DONE',
    '───────────────────────────────────────────────',
    `  Total reviewed:     ${dod.totalReviewed}`,
    `  Adequacy rate:      ${formatPct(dod.adequacyRate)} ${dod.isAdequacyThresholdMet ? '✓' : '✗'} (target ≥80%)`,
    `  Volume threshold:   ${dod.isVolumeThresholdMet ? '✓' : '✗'} (${dod.totalReviewed}/25)`,
    `  DoD met:            ${dod.isDoDMet ? 'YES ✓' : 'NO ✗'}`,
    '───────────────────────────────────────────────',
    '  TIER DISTRIBUTION',
    '───────────────────────────────────────────────',
    `  A: ${dod.tierDistribution.A}  B: ${dod.tierDistribution.B}  C: ${dod.tierDistribution.C}`,
    '───────────────────────────────────────────────',
    '  MISSING EVIDENCE',
    '───────────────────────────────────────────────',
  ];

  for (const [type, count] of Object.entries(dod.missingEvidenceDistribution)) {
    lines.push(`  ${type}: ${count}`);
  }

  if (dod.leadTimeDays.median !== null) {
    lines.push('───────────────────────────────────────────────');
    lines.push(`  Lead time median: ${dod.leadTimeDays.median} days`);
  }

  lines.push('═══════════════════════════════════════════════');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const dbPath = process.env['REVIEW_DB_PATH'] ?? 'data/review-queue.db';
  const db = new Database(dbPath);
  const queue = createReviewQueue({ db });
  const stats = await queue.getStats();
  console.log(formatStats(stats));
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error('[review-stats] Fatal error:', err);
    process.exit(1);
  });
}
