# SPEC: Review Queue
<!-- spec-version: 1.0 -->
<!-- status: forward -->
<!-- signed-by: -->
<!-- date: 2026-04-29 -->
<!-- superseded-by: -->

## 1. Intent

The Review Queue is the final sub-module of Module A in the FinScout discovery pipeline. It receives `EnrichedProfile` records produced by the `EnrichmentEngine` orchestrator, presents them to the reviewer in FIFO order, captures `ReviewAnnotation` judgments, and measures progress toward the Phase 1 Definition of Done (DoD).

**Design posture: thin storage boundary.** The Review Queue manages queue state and validation. It does not compute tier scores, apply heuristics, or make automated judgments. All decisions are human-in-the-loop.

**Persistence: SQLite via `better-sqlite3`.** Single-file, zero-config, aligned with solo-reviewer Phase 1 scale. Postgres is explicitly deferred to Phase 2 if concurrent multi-reviewer workflows become real (confirmed in architecture v0.2.1 §8.3).

**Phase 1 DoD is a hard quality gate.** Module B (Scoring Agent) work does not begin until the three DoD conditions are met simultaneously: ≥25 profiles reviewed, ≥80% adequacy rate, and no single `MissingEvidenceType` dominating >40% of failures.

**Scope boundary.** This spec covers:
- The `ReviewQueue` storage and CRUD interface.
- The `calculateDoDMetrics()` pure function for DoD measurement.
- The `QueueItem` state machine (`pending → reviewed`, `pending → dropped`).
- CLI command behavioral contracts (rendering and interactive input are implementation details).

Out of scope: Module B (Scoring Agent), LinkedIn outreach, automated tier prediction, multi-reviewer workflows, any data source beyond the `EnrichedProfile` contract.

---

## 2. Functional Contract

| Operation | Input | Output | Idempotent | Side Effects |
|-----------|-------|--------|------------|--------------|
| `createReviewQueue(deps)` | `ReviewQueueDeps` | `ReviewQueue` | Yes | Runs `CREATE TABLE IF NOT EXISTS` DDL |
| `push(profile)` | `EnrichedProfile` | `Promise<void>` | Yes (same id = no-op) | Writes one row to `queue_items` |
| `listPending()` | — | `Promise<QueueItem[]>` | Yes | None |
| `get(id)` | `string` | `Promise<QueueItem \| undefined>` | Yes | None |
| `submitReview(id, annotation)` | `string`, `ReviewAnnotation` | `Promise<void>` | No | Updates one row in `queue_items` |
| `drop(id)` | `string` | `Promise<void>` | No | Updates one row in `queue_items` |
| `getStats()` | — | `Promise<ReviewQueueStats>` | Yes | None |
| `exportReviewed()` | — | `Promise<QueueItem[]>` | Yes | None |
| `calculateDoDMetrics(annotations)` | `ReviewAnnotation[]` | `DoDMetrics` | Yes | None (pure) |

---

## 3. Interface Contract

> All types are TypeScript interfaces unless noted as Zod schemas. `EnrichedProfile`, `EnrichedProfileSchema`, `ReviewAnnotation`, `ReviewAnnotationSchema`, `MissingEvidenceType`, and `FundingStage` are imported from `src/schema/enrichedProfile.ts`. `Database` is imported from `better-sqlite3`. No new Zod schemas are defined in this module; validation delegates entirely to imported schemas.

### 3.1 Queue Item

```typescript
export type QueueItemStatus = 'pending' | 'reviewed' | 'dropped';

export interface QueueItem {
  id: string;                 // same as profile.id (uuid)
  profile: EnrichedProfile;
  status: QueueItemStatus;
  enqueuedAt: string;         // ISO 8601
  reviewedAt?: string;        // ISO 8601 — present only when status === 'reviewed'
  annotation?: ReviewAnnotation;
}
```

**State machine:**

```
push()            →  pending
submitReview()    →  reviewed   (from pending or dropped; throws AlreadyReviewedError if already reviewed)
drop()            →  dropped    (from pending only; throws AlreadyReviewedError if already reviewed)
```

Rows are never deleted. `get()` returns items in any state.

### 3.2 Metrics Types

```typescript
export interface DoDMetrics {
  totalReviewed: number;
  adequacyRate: number;                                    // float [0, 1]
  adequacyRatePct: number;                                 // 0–100 (adequacyRate × 100)
  isVolumeThresholdMet: boolean;                           // totalReviewed >= 25
  isAdequacyThresholdMet: boolean;                         // adequacyRate >= 0.80
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
```

### 3.3 ReviewQueue

```typescript
export interface ReviewQueueDeps {
  db: Database;   // better-sqlite3 Database instance; caller opens the file
}

export interface ReviewQueue {
  push(profile: EnrichedProfile): Promise<void>;
  listPending(): Promise<QueueItem[]>;
  get(id: string): Promise<QueueItem | undefined>;
  submitReview(id: string, annotation: ReviewAnnotation): Promise<void>;
  drop(id: string): Promise<void>;
  getStats(): Promise<ReviewQueueStats>;
  exportReviewed(): Promise<QueueItem[]>;
}

export function createReviewQueue(deps: ReviewQueueDeps): ReviewQueue;
```

### 3.4 MetricsCalculator

```typescript
export function calculateDoDMetrics(annotations: ReviewAnnotation[]): DoDMetrics;
```

Pure function: synchronous, no I/O, no side effects. Accepts the full set of `ReviewAnnotation` records for items with `status='reviewed'`. Used internally by `getStats()`.

### 3.5 Error Classes

```typescript
export class ReviewQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewQueueError';
  }
}

export class DuplicateProfileError extends ReviewQueueError {
  constructor(public readonly profileId: string) {
    super(`Profile already exists in queue: ${profileId}`);
    this.name = 'DuplicateProfileError';
  }
}

export class NotFoundError extends ReviewQueueError {
  constructor(public readonly profileId: string) {
    super(`Queue item not found: ${profileId}`);
    this.name = 'NotFoundError';
  }
}

export class AlreadyReviewedError extends ReviewQueueError {
  constructor(public readonly profileId: string) {
    super(`Queue item has already been reviewed: ${profileId}`);
    this.name = 'AlreadyReviewedError';
  }
}

export class AnnotationMismatchError extends ReviewQueueError {
  constructor(
    public readonly itemId: string,
    public readonly annotationProfileId: string,
  ) {
    super(
      `Annotation profileId (${annotationProfileId}) does not match item id (${itemId})`,
    );
    this.name = 'AnnotationMismatchError';
  }
}
```

---

## 4. Boundary Contract

### 4.1 ReviewQueue Storage

- Calls `db.exec()` with `CREATE TABLE IF NOT EXISTS` DDL during `createReviewQueue()` so the table exists before any operation is attempted. DDL:

```sql
CREATE TABLE IF NOT EXISTS queue_items (
  id              TEXT PRIMARY KEY,
  profile_json    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  enqueued_at     TEXT NOT NULL,
  reviewed_at     TEXT,
  annotation_json TEXT
);
```

- All `EnrichedProfile` objects are serialized to JSON strings for `profile_json` on write; on read, the JSON is deserialized and passed through `EnrichedProfileSchema.parse()` before being returned to the caller.
- All `ReviewAnnotation` objects are serialized to JSON strings for `annotation_json` on write; on read, deserialized and passed through `ReviewAnnotationSchema.parse()` before being returned.
- Uses `better-sqlite3` synchronous API internally. Public methods are `async` so callers can treat the interface as async and migration to an async driver requires no caller-side changes.
- All write operations use parameterized SQLite statements. No raw string interpolation of user-supplied values.

### 4.2 push()

- Validates the profile via `EnrichedProfileSchema.parse()` before writing; throws `ZodError` if the profile fails validation.
- If a row with the same `id` already exists, returns immediately without writing. No error is thrown. This is the deduplication contract: the enrichment caller may produce the same profile across two polls; the queue absorbs re-pushes silently.
- Sets `enqueued_at` to `new Date().toISOString()` at call time.
- Does NOT set `reviewed_at` or `annotation_json` on the new row.

### 4.3 submitReview()

- Validates the annotation via `ReviewAnnotationSchema.parse()` before any DB access. This enforces the `.refine()` constraint: `profileAdequate=false` requires `missingEvidenceTypes.length >= 1`; `profileAdequate=true` requires `missingEvidenceTypes.length === 0`. Throws `ZodError` on failure.
- Throws `NotFoundError` when `id` has no matching row.
- Throws `AnnotationMismatchError` when `annotation.profileId !== id`.
- Throws `AlreadyReviewedError` when the item's current `status === 'reviewed'`.
- Items with `status='dropped'` may be submitted — `submitReview()` does not reject dropped items. A reviewer may have dropped an item and then decided to review it after all (repair workflow).
- On success: sets `status = 'reviewed'`, `reviewed_at = new Date().toISOString()`, writes `annotation_json`.

### 4.4 drop()

- Throws `NotFoundError` when `id` has no matching row.
- Throws `AlreadyReviewedError` when the item's current `status === 'reviewed'`. A reviewed item cannot be dropped; explicit rejection prevents silent loss of reviewer work.
- On success: sets `status = 'dropped'`. Row is retained for audit.
- Dropped items do not appear in `listPending()` and are excluded from `calculateDoDMetrics` input.

### 4.5 calculateDoDMetrics()

- Pure function. Caller is responsible for fetching all reviewed annotations from the DB before calling.
- `totalReviewed` = `annotations.length`.
- `adequacyRate` = `annotations.filter(a => a.profileAdequate).length / totalReviewed`; returns `0` when `totalReviewed === 0`. `adequacyRatePct` = `adequacyRate × 100`.
- `missingEvidenceDistribution`: counts each `MissingEvidenceType` across annotations where `profileAdequate === false`. All five enum values (`missing_tech_stack`, `missing_traction_signal`, `missing_founder_context`, `missing_architecture_signal`, `noise_false_positive`) are always present as keys, with count `0` if not observed.
- `dominantFailureModeExceeds40Pct`: let `inadequateCount = annotations.filter(a => !a.profileAdequate).length`. If `inadequateCount === 0`, returns `false`. Otherwise returns `true` if any single distribution value `> inadequateCount × 0.40`.
- `tierDistribution`: counts `'A'`, `'B'`, `'C'` across all supplied annotations. All three keys always present.
- `leadTimeDays`: computed from annotations where `crunchbaseCheck.foundInCrunchbase === true` AND the annotation has `crunchbaseCheck.actualDate` AND the corresponding profile has `funding.claimed.claimedAt`. `median` is `null` when `values.length === 0`.
- `isDoDMet` = `isVolumeThresholdMet && isAdequacyThresholdMet && !dominantFailureModeExceeds40Pct`.

### 4.6 CLI Commands (behavioral contracts)

The three CLI commands from architecture §8.2 are behavioral contracts, not implementation requirements of this spec:

- `review:next` — calls `listPending()`, takes the first item, renders the `EnrichedProfile` summary, captures interactive annotation from the reviewer, calls `submitReview()`.
- `review:stats` — calls `getStats()`, renders DoD progress toward Phase 1 exit conditions.
- `review:export` — calls `exportReviewed()`, serializes to stdout as NDJSON.

CLI rendering and interactive input are implementation details and are not tested here.

---

## 5. Acceptance Criteria

### Group A: Queue CRUD

- AC-001: `createReviewQueue()` accepts a `better-sqlite3` `Database` instance and runs the `CREATE TABLE IF NOT EXISTS queue_items` DDL so the table exists before any operation is attempted.
- AC-002: `push()` validates the incoming `EnrichedProfile` via `EnrichedProfileSchema.parse()` before writing; throws `ZodError` when the profile fails schema validation.
- AC-003: `push()` persists the profile as a new queue item with `status='pending'` and `enqueuedAt` set to the current ISO timestamp.
- AC-004: `push()` is idempotent — calling it twice with the same `profile.id` produces exactly one row in `queue_items` and no error on the second call.
- AC-005: `listPending()` returns only items with `status='pending'`, ordered by `enqueuedAt` ascending (FIFO); items with `status='reviewed'` or `status='dropped'` are excluded.
- AC-006: `get(id)` returns the full `QueueItem` including the deserialized `EnrichedProfile` and `annotation` when present; returns `undefined` for an unknown `id`.

### Group B: Review Submission

- AC-007: `submitReview()` calls `ReviewAnnotationSchema.parse()` on the annotation before any DB access; propagates `ZodError` when validation fails (including when the `.refine()` constraint is violated).
- AC-008: `submitReview()` transitions item `status` from `'pending'` to `'reviewed'`, writes `annotation_json`, and sets `reviewed_at` to the current ISO timestamp.
- AC-009: `submitReview()` throws `AlreadyReviewedError` when the target item has `status='reviewed'`.
- AC-010: `submitReview()` throws `NotFoundError` when `id` has no matching queue item.
- AC-011: `submitReview()` throws `AnnotationMismatchError` when `annotation.profileId !== id`.

### Group C: Metrics & DoD Calculation

- AC-012: `calculateDoDMetrics([])` returns `totalReviewed: 0`, `adequacyRate: 0`, `adequacyRatePct: 0`, `isDoDMet: false`, all five `missingEvidenceDistribution` values `0`, and `leadTimeDays: { median: null, values: [] }`.
- AC-013: `adequacyRate` equals `count(profileAdequate === true) / totalReviewed` as a float in `[0, 1]`; `adequacyRatePct` equals `adequacyRate × 100`; both are `0` when `totalReviewed === 0`.
- AC-014: `isVolumeThresholdMet` is `true` when `totalReviewed >= 25`; `isAdequacyThresholdMet` is `true` when `adequacyRate >= 0.80`.
- AC-015: `isDoDMet` is `true` only when `isVolumeThresholdMet && isAdequacyThresholdMet && !dominantFailureModeExceeds40Pct` are simultaneously true; any single condition failing yields `isDoDMet: false`.
- AC-016: `missingEvidenceDistribution` counts each `MissingEvidenceType` across annotations where `profileAdequate === false`; all five enum values are always present as keys, with count `0` when unobserved.
- AC-017: `dominantFailureModeExceeds40Pct` is `true` when any single `MissingEvidenceType` count is greater than `40%` of the total inadequate-profile count; returns `false` when there are zero inadequate profiles.
- AC-018: `tierDistribution` counts tier `'A'`, `'B'`, `'C'` across all reviewed annotations; `dropped` items are excluded from all metric calculations.

### Group D: Export & Drop

- AC-019: `exportReviewed()` returns all `QueueItem[]` with `status='reviewed'`, each including the full deserialized `annotation`.
- AC-020: `drop(id)` transitions item to `status='dropped'`; the item no longer appears in `listPending()` results.
- AC-021: `drop(id)` throws `NotFoundError` for an unknown `id`; throws `AlreadyReviewedError` when the item has `status='reviewed'`.

### Group E: getStats & Schema Enforcement

- AC-022: `getStats()` returns `ReviewQueueStats` with live `pendingCount`, `reviewedCount`, `droppedCount`, and `dod` computed by passing all reviewed annotations through `calculateDoDMetrics()`; dropped items are excluded from the `dod` input.

---

## 6. MVA Constraints

### 6.1 Security Boundaries

- All `EnrichedProfile` values are validated via `EnrichedProfileSchema.parse()` at ingress in `push()` and at egress when deserializing from SQLite in `get()`, `listPending()`, and `exportReviewed()`.
- All `ReviewAnnotation` values are validated via `ReviewAnnotationSchema.parse()` at ingress in `submitReview()` and at egress when deserializing from SQLite.
- `profile_json` and `annotation_json` column values are treated as untrusted data on read; deserialization always passes through Zod before any code consumes the result.
- All SQLite write operations use parameterized statements. No raw string interpolation of user-supplied values.

### 6.2 Resource Ceilings

- `push()` writes at most one row per unique profile id.
- `submitReview()` and `drop()` each update exactly one row.
- `listPending()` and `exportReviewed()` are unbounded reads; at Phase 1 volumes (25-40 profiles) this is acceptable. Pagination is deferred.
- `calculateDoDMetrics()` is O(n) on annotation count; no I/O.
- No persistent state beyond the SQLite file. No background workers, no connection pooling.

### 6.3 Failure Modes & Degradation

- `ZodError` from `push()` → invalid profile from upstream; indicates a bug in `ProfileComposer` or the enrichment caller.
- `ZodError` from `submitReview()` → invalid annotation; surfaces `.refine()` constraint violations to the CLI reviewer for correction.
- `NotFoundError` → stale or incorrect ID supplied by the caller.
- `AlreadyReviewedError` → human attempted to re-review or drop a finalized item; UX-level signal, not a silent failure.
- `AnnotationMismatchError` → annotation constructed for a different profile; caller error.
- SQLite write failures (disk full, locked file) propagate from `better-sqlite3` as-is.

### 6.4 Phase 2 Deferrals

- **Multi-reviewer workflows** — no locking, no reviewer assignment, no concurrency tokens. `reviewedBy` in the annotation carries reviewer identity. Single reviewer `"dmitriy"` for Phase 1.
- **Postgres or other RDBMS** — SQLite only in Phase 1. Migration path: replace `better-sqlite3` `Database` injection with a compatible interface; no caller changes required.
- **Web UI** — CLI-only in Phase 1.
- **Pagination** — `listPending()` and `exportReviewed()` return full result sets. Add pagination when queue exceeds manageable in-memory size.
- **Re-review / annotation versioning** — once reviewed, an item is terminal in Phase 1. Future phases may allow re-review; would require a separate `annotations` table and audit log.
- **Automated adequacy scoring** — `profileAdequate` is reviewer-asserted only. Module B is the automated scoring layer; it begins after Phase 1 DoD is met.
- **Lead-time alerting** — `leadTimeDays` is a read-only metric; no alerting or threshold enforcement in Phase 1.
- **`review:next` interactive rendering** — the CLI command behavioral contract is specified; the specific terminal UI (compact profile summary, clickable links, interactive prompts) is an implementation detail not tested here.

---

## 7. Test Scaffold Reference

See: specs/review-queue/test-scaffold.md
