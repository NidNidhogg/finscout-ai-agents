import Database from 'better-sqlite3';
import { prompt } from 'enquirer';
import { createReviewQueue } from '../review-queue/ReviewQueue';
import type { ReviewAnnotation, MissingEvidenceType, DowngradeReason } from '../schema/enrichedProfile';

const MISSING_EVIDENCE_OPTIONS: MissingEvidenceType[] = [
  'missing_tech_stack',
  'missing_traction_signal',
  'missing_founder_context',
  'missing_architecture_signal',
  'noise_false_positive',
];

const DOWNGRADE_REASON_OPTIONS: DowngradeReason[] = [
  'competency_mismatch',
  'wrong_vertical',
  'business_risk_override',
  'stage_too_late',
  'stage_too_early',
  'acquired_or_state_backed',
];

function printDivider(): void {
  console.log('═══════════════════════════════════════════════');
}

async function main(): Promise<void> {
  const dbPath = process.env['REVIEW_DB_PATH'] ?? 'data/review-queue.db';
  const reviewedBy = process.env['REVIEWER_ID'] ?? 'unknown';

  const db = new Database(dbPath);
  const queue = createReviewQueue({ db });

  const pending = await queue.listPending();
  if (pending.length === 0) {
    console.log('[review-next] No pending items in queue.');
    return;
  }

  const item = pending[0];
  const { profile } = item;

  printDivider();
  console.log(`  REVIEW: ${profile.company.name}`);
  printDivider();
  console.log(`  ID:          ${profile.id}`);
  console.log(`  Website:     ${profile.company.websiteUrl}`);
  console.log(`  X:           ${profile.company.xHandle ?? 'N/A'}`);
  console.log(`  Funding:     ${profile.funding.claimed.rawText ?? 'N/A'}`);
  const firstTweet = profile.rawContent.sourceTweets?.[0];
  if (firstTweet) console.log(`  Source tweet: ${firstTweet.text}`);
  console.log('───────────────────────────────────────────────');
  console.log(`  Architecture: ${profile.product.architectureTerms.join(', ') || 'none'}`);
  console.log(`  Stack:        ${profile.product.stackMentions.join(', ') || 'none'}`);
  printDivider();
  console.log(`  ${pending.length - 1} more items pending after this.\n`);

  const { profileAdequate } = await prompt<{ profileAdequate: boolean }>({
    type: 'confirm',
    name: 'profileAdequate',
    message: 'Is this profile adequate?',
  });

  let missingEvidenceTypes: MissingEvidenceType[] = [];
  if (!profileAdequate) {
    const { missing } = await prompt<{ missing: MissingEvidenceType[] }>({
      type: 'multiselect',
      name: 'missing',
      message: 'Select missing evidence types (space to toggle, enter to confirm):',
      choices: MISSING_EVIDENCE_OPTIONS,
    });
    missingEvidenceTypes = missing;
  }

  const { tier } = await prompt<{ tier: 'A' | 'B' | 'C' }>({
    type: 'select',
    name: 'tier',
    message: 'Assign tier:',
    choices: ['A', 'B', 'C'],
  });

  const { tierReason } = await prompt<{ tierReason: string }>({
    type: 'input',
    name: 'tierReason',
    message: 'Tier reason:',
  });

  const { reviewerNote } = await prompt<{ reviewerNote: string }>({
    type: 'input',
    name: 'reviewerNote',
    message: 'Reviewer note (optional, press Enter to skip):',
  });

  let downgradeReasons: DowngradeReason[] | undefined;
  if (tier !== 'A') {
    const { reasons } = await prompt<{ reasons: DowngradeReason[] }>({
      type: 'multiselect',
      name: 'reasons',
      message: 'Downgrade reasons (optional):',
      choices: DOWNGRADE_REASON_OPTIONS,
    });
    downgradeReasons = reasons.length > 0 ? reasons : undefined;
  }

  const { crunchbaseChecked } = await prompt<{ crunchbaseChecked: boolean }>({
    type: 'confirm',
    name: 'crunchbaseChecked',
    message: 'Did you check Crunchbase?',
  });

  let foundInCrunchbase: boolean | undefined;
  if (crunchbaseChecked) {
    const { found } = await prompt<{ found: boolean }>({
      type: 'confirm',
      name: 'found',
      message: 'Found in Crunchbase?',
    });
    foundInCrunchbase = found;
  }

  const annotation: ReviewAnnotation = {
    profileId: item.id,
    reviewedAt: new Date().toISOString(),
    reviewedBy,
    profileAdequate,
    missingEvidenceTypes,
    tier,
    tierReason: tierReason.trim() || 'manual review',
    downgradeReasons,
    reviewerNote: reviewerNote.trim() || undefined,
    crunchbaseCheck: {
      checked: crunchbaseChecked,
      foundInCrunchbase,
    },
  };

  await queue.submitReview(item.id, annotation);
  console.log(`\n[review-next] Review submitted for ${profile.company.name}.`);
  console.log(`[review-next] ${pending.length - 1} items remaining in queue.`);
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error('[review-next] Fatal error:', err);
    process.exit(1);
  });
}
