# SPEC: Fingerprint Data Contract & Resolver
<!-- spec-version: 1.0 -->
<!-- status: forward -->
<!-- signed-by: -->
<!-- date: 2026-04-24 -->
<!-- superseded-by: -->

## 1. Intent

The fingerprint subsystem defines the vocabulary artifacts that Module A (EnrichmentEngine) uses to identify Web3 companies matching RadianceTeam's competency matrix. Two Core files carry universal Web3 B2B quality markers and retail/speculation anti-signals. Five Cell files extend the Core with per-cell architectural vocabulary. The runtime resolver `resolveFingerprint()` loads and merges these files into a single `ResolvedFingerprint` ready for Stage 2 pre-filter and website-enrichment matching.

**Phase 1 scope — deliberate MVA narrowing.** This spec covers the data file format, Core+Cell inheritance rules, and the runtime resolver. The curation commands (`fingerprint:suggest`, `fingerprint:review`, `fingerprint:compile`, `fingerprint:validate`) and the AI-assisted vocabulary extraction workflow from architecture §10.4 are explicitly deferred to Phase 2. Phase 1's 7 JSON files (2 core + 5 cell) are hand-authored; building automation to generate 7 files is a YAGNI trap. See §6.6.

**`resolvedAt` addition.** `ResolvedFingerprintSchema` includes a `resolvedAt` field that the architecture doc §10.3 sketch does not specify. This field was added deliberately: it provides a timestamp useful for cache invalidation and test assertion precision. It does not change the merge semantics.

Like `specs/enriched-profile/spec.md`, this is a data-contract spec where the Zod schemas in Section 3 are the normative interface definitions, not pseudocode.

## 2. Functional Contract

| Operation | Input | Output | Idempotent | Side Effects |
|-----------|-------|--------|------------|--------------|
| `CoreFingerprintFileSchema.parse()` | `unknown` (raw JSON object from file) | `CoreFingerprintFile` | Yes | None |
| `CellFingerprintFileSchema.parse()` | `unknown` (raw JSON object from file) | `CellFingerprintFile` | Yes | None |
| `resolveFingerprint(cell, basePath?)` | `CompetencyCell` + optional path | `ResolvedFingerprint` | Yes | Reads 3 files from `basePath` |

## 3. Interface Contract

> All schemas use Zod v4. Both `CoreFingerprintFileSchema` and `CellFingerprintFileSchema` use `.strict()` — unrecognized fields cause parse failure rather than silent stripping. `CompetencyCellSchema` and `CompetencyCell` are imported from `src/schema/enrichedProfile.ts`; they are not redefined here.

### 3.1 FingerprintFileSchema

```typescript
import { z } from 'zod';
import { CompetencyCellSchema, type CompetencyCell } from '../schema/enrichedProfile';

export const SignalSchema = z.object({
  term: z.string().min(1),
  weight: z.number().positive().max(3),
  notes: z.string().optional(),
});

const uniqueTerms = (signals: Array<{ term: string }>): boolean =>
  new Set(signals.map((s) => s.term)).size === signals.length;

const uniqueTermsConfig = { message: 'Duplicate terms are not allowed within a signal array' };

export const CoreFingerprintFileSchema = z.object({
  version: z.literal('1.0'),
  lastCurated: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD'),
  curator: z.string().min(1),
  primarySignals: z.array(SignalSchema).refine(uniqueTerms, uniqueTermsConfig),
  antiSignals: z.array(SignalSchema).refine(uniqueTerms, uniqueTermsConfig),
}).strict();

export const CellFingerprintFileSchema = z.object({
  version: z.literal('1.0'),
  lastCurated: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD'),
  curator: z.string().min(1),
  cell: CompetencyCellSchema,
  extends: z.array(z.string().min(1)).min(2),
  primarySignals: z.array(SignalSchema).refine(uniqueTerms, uniqueTermsConfig),
  antiSignals: z.array(SignalSchema).refine(uniqueTerms, uniqueTermsConfig),
}).strict();

export type CoreFingerprintFile = z.infer<typeof CoreFingerprintFileSchema>;
export type CellFingerprintFile = z.infer<typeof CellFingerprintFileSchema>;
export type Signal = z.infer<typeof SignalSchema>;
```

### 3.2 ResolvedFingerprintSchema

```typescript
export const ResolvedFingerprintSchema = z.object({
  cell: CompetencyCellSchema,
  resolvedAt: z.string().datetime(),
  primarySignals: z.array(SignalSchema),
  antiSignals: z.array(SignalSchema),
});

export type ResolvedFingerprint = z.infer<typeof ResolvedFingerprintSchema>;
```

### 3.3 resolveFingerprint

**Cell → filename mapping** (hardcoded `Record<CompetencyCell, string>`; non-algorithmic — `"DeFi & Yield"` cannot be derived mechanically):

| `CompetencyCell` value | Filename under `cells/` |
|------------------------|-------------------------|
| `"DeFi & Yield"` | `defi-&-yield.json` |
| `"Trading"` | `trading.json` |
| `"Infrastructure"` | `infrastructure.json` |
| `"Security"` | `security.json` |
| `"Payment Rails"` | `payment-rails.json` |

**Error classes:**

```typescript
export class FingerprintNotFoundError extends Error {
  constructor(public readonly filePath: string) {
    super(`Fingerprint file not found: ${filePath}`);
    this.name = 'FingerprintNotFoundError';
  }
}

export class FingerprintValidationError extends Error {
  constructor(public readonly filePath: string, public readonly cause?: unknown) {
    super(`Fingerprint validation failed for: ${filePath}`);
    this.name = 'FingerprintValidationError';
  }
}

export class FingerprintCollisionError extends Error {
  constructor(
    public readonly term: string,
    public readonly file1: string,
    public readonly file2: string,
  ) {
    super(`Term collision between ${file1} and ${file2}: "${term}"`);
    this.name = 'FingerprintCollisionError';
  }
}
```

**Function signature and behavior:**

```typescript
/**
 * Loads core-web3-signals.json, core-web3-anti-signals.json, and the
 * cell-specific file from `basePath`. Validates each with the appropriate
 * Zod schema. Merges per Core+Cell inheritance rules. Returns ResolvedFingerprint.
 *
 * basePath defaults to 'data/fingerprints' (relative to process.cwd()).
 * Override in tests to point at fixture directories under data/fixtures/fingerprints/.
 *
 * Merge algorithm:
 *   1. Parse core-web3-signals.json with CoreFingerprintFileSchema. Throw
 *      FingerprintNotFoundError if file absent; FingerprintValidationError on
 *      JSON.parse failure or Zod validation failure.
 *   2. Parse core-web3-anti-signals.json with CoreFingerprintFileSchema.
 *      Same error semantics.
 *   3. Check cross-core collisions (same-type only):
 *      - Any term in core-web3-signals.primarySignals that also appears in
 *        core-web3-anti-signals.primarySignals → throw FingerprintCollisionError.
 *      - Any term in core-web3-signals.antiSignals that also appears in
 *        core-web3-anti-signals.antiSignals → throw FingerprintCollisionError.
 *   4. Parse cells/<cellFilename>.json with CellFingerprintFileSchema.
 *      Same error semantics.
 *   5. Validate cell's extends array (semantic checks):
 *      a. Must include "core-web3-signals" — throw FingerprintValidationError if absent.
 *      b. Must include "core-web3-anti-signals" — throw FingerprintValidationError if absent.
 *      c. Must not contain any name other than those two — throw FingerprintValidationError
 *         (shallow-only; cell-extends-cell is not supported in Phase 1).
 *   6. Merge primarySignals: build a Map<term, Signal> seeded from
 *      core-web3-signals.primarySignals, then core-web3-anti-signals.primarySignals,
 *      then cell primarySignals (cell entry overwrites on term collision). Result is
 *      [...map.values()] — insertion-order stable, deterministic.
 *   7. Merge antiSignals: same algorithm using each file's antiSignals.
 *   8. Return { cell, resolvedAt: new Date().toISOString(), primarySignals, antiSignals }.
 */
export async function resolveFingerprint(
  cell: CompetencyCell,
  basePath: string = 'data/fingerprints',
): Promise<ResolvedFingerprint>
```

## 4. Boundary Contract

### 4.1 FingerprintFile

- Does NOT: make network calls; read or write files; access external services.
- Assumes: all inputs arrive as `unknown` (parsed from raw JSON strings read by the caller); `CoreFingerprintFileSchema.parse()` or `CellFingerprintFileSchema.parse()` runs at the file-load boundary before any merge or resolution.
- `.strict()` on both schemas: an object containing unrecognized fields (e.g., a cell file passed to `CoreFingerprintFileSchema`) fails validation. This prevents silent data loss from misapplied schema.
- Both `primarySignals` and `antiSignals` are required in both schemas; either may be an empty array. No minimum signal count is enforced.
- Term weights are validated strictly within `(0, 3]` at parse time. Zero, negative, and above-3 weights are schema-invalid.
- Duplicate terms within a signal array are rejected by `.refine()` at parse time. Duplicate terms across `primarySignals` and `antiSignals` within the same file are not enforced (not required by the architecture contract).

### 4.2 resolveFingerprint

- Depends on: `fs/promises` (Node.js built-in); `CoreFingerprintFileSchema`, `CellFingerprintFileSchema`, `ResolvedFingerprintSchema` (this module); `CompetencyCell` from `src/schema/enrichedProfile.ts`.
- Does NOT: write files; modify fingerprint artifacts on disk; cache results across calls; make network requests.
- `basePath` is the caller's responsibility. Production callers use `'data/fingerprints'`; tests override to point at fixture directories.
- Throws on any error — no partial results, no swallowed exceptions. The three error classes are the complete error surface.
- The two core file names (`"core-web3-signals"`, `"core-web3-anti-signals"`) are hardcoded constants. The cell-to-filename mapping is a hardcoded `Record<CompetencyCell, string>`. Neither is configurable.
- `extends` shallow-only enforcement: any entry in a cell file's `extends` that is not one of the two core names causes `FingerprintValidationError`. Multi-level inheritance (cell extending cell) is not supported in Phase 1.
- Cross-core collision check is same-type only: `primarySignals ↔ primarySignals`, `antiSignals ↔ antiSignals`. Cross-type inconsistency (same term as primary in one file and anti in another) is not enforced.

## 5. Acceptance Criteria

### FingerprintFile schema validation

- AC-001: A valid core fingerprint object with `version`, `lastCurated`, `curator`, `primarySignals`, and `antiSignals` must parse with `CoreFingerprintFileSchema` successfully.
- AC-002: A valid cell fingerprint object with `version`, `lastCurated`, `curator`, `cell`, `extends`, `primarySignals`, and `antiSignals` must parse with `CellFingerprintFileSchema` successfully.
- AC-003: An object containing an `extends` field must fail `CoreFingerprintFileSchema` validation (`.strict()` rejects unrecognized fields).
- AC-004: A cell-format object missing the `extends` field must fail `CellFingerprintFileSchema` validation.
- AC-005: A cell-format object with an `extends` array containing fewer than 2 entries must fail `CellFingerprintFileSchema` validation.
- AC-006: A cell-format object missing the `cell` field must fail `CellFingerprintFileSchema` validation.
- AC-007: `version` set to any value other than `"1.0"` must fail validation in both `CoreFingerprintFileSchema` and `CellFingerprintFileSchema`.
- AC-008: A signal entry with `weight` equal to `0`, a negative number, or a value greater than `3` must fail `SignalSchema` validation.

### Inheritance rules

- AC-009: If a cell file's `extends` array omits `"core-web3-signals"` or omits `"core-web3-anti-signals"`, `resolveFingerprint` must throw `FingerprintValidationError`.
- AC-010: If a cell file's `extends` array contains any entry other than `"core-web3-signals"` or `"core-web3-anti-signals"`, `resolveFingerprint` must throw `FingerprintValidationError` (shallow-only enforcement).
- AC-011: If a filename listed in `extends` does not exist on the filesystem, `resolveFingerprint` must throw `FingerprintNotFoundError` whose `filePath` property names the missing file.
- AC-012: When a term appears in both a core file's `primarySignals` and the cell file's `primarySignals`, the resolved `primarySignals` must contain the cell file's entry (cell wins; core entry is replaced).
- AC-013: When the same term appears in both `core-web3-signals.primarySignals` and `core-web3-anti-signals.primarySignals`, or in both files' `antiSignals`, `resolveFingerprint` must throw `FingerprintCollisionError` whose `term` property names the conflicting term.

### resolveFingerprint — happy paths

- AC-014: Given valid fixture files for both core files and the requested cell, `resolveFingerprint` must return a `ResolvedFingerprint` without throwing.
- AC-015: The resolved `primarySignals` must contain terms from both the core fixture file(s) and the cell fixture file.
- AC-016: The resolved `antiSignals` must contain terms from both the core fixture file(s) and the cell fixture file.
- AC-017: `ResolvedFingerprint.cell` must equal the `CompetencyCell` value passed to `resolveFingerprint`.

### resolveFingerprint — error paths

- AC-018: When a core file is absent from `basePath`, `resolveFingerprint` must throw `FingerprintNotFoundError` whose `filePath` references the missing core file path.
- AC-019: When the cell file is absent from `basePath/cells/`, `resolveFingerprint` must throw `FingerprintNotFoundError` whose `filePath` references the missing cell file path.
- AC-020: When any fingerprint file contains malformed JSON, `resolveFingerprint` must throw `FingerprintValidationError` whose `filePath` references the malformed file.
- AC-021: When any fingerprint file contains valid JSON that fails `CoreFingerprintFileSchema` or `CellFingerprintFileSchema` validation, `resolveFingerprint` must throw `FingerprintValidationError` whose `filePath` references the invalid file.

### ResolvedFingerprint output shape

- AC-022: The object returned by `resolveFingerprint` must validate against `ResolvedFingerprintSchema` without error.
- AC-023: Every signal in the resolved `primarySignals` and `antiSignals` must have `weight` strictly within `(0, 3]`.
- AC-024: No term appears more than once in the resolved `primarySignals`; no term appears more than once in the resolved `antiSignals`.
- AC-025: `ResolvedFingerprint.resolvedAt` must be a valid ISO 8601 datetime string.

## 6. MVA Constraints

### 6.1 Security Boundaries

- All file content is parsed as `unknown` and validated through Zod before any merge processing. No raw type assertions at the file-load boundary.
- No `eval`, no dynamic `require`. File paths are constructed from the hardcoded cell-to-filename mapping and the caller-supplied `basePath` — no user-controlled path injection into the merge logic.
- Term matching downstream (in Module A) operates on the resolved `Signal` array; no user-controlled regex or eval is involved in the fingerprint layer itself.

### 6.2 Resource Ceilings

- `resolveFingerprint` reads exactly 3 files per call: 2 core files + 1 cell file. O(1) I/O operations.
- No caching, no background workers, no connection pooling. Calls are independent and idempotent.
- Signal array sizes are bounded by hand-authored vocabulary counts. All processing is O(n) on vocabulary size.

### 6.3 Failure Modes & Degradation

- Missing file → `FingerprintNotFoundError` with `filePath`; never a partial result.
- Malformed JSON → `FingerprintValidationError` with `filePath`; JSON.parse error exposed as `cause`.
- Zod validation failure → `FingerprintValidationError` with `filePath`; ZodError exposed as `cause`.
- Cross-core collision → `FingerprintCollisionError`; pipeline cannot proceed with a corrupt vocabulary definition.
- No partial results: `resolveFingerprint` either returns a complete `ResolvedFingerprint` or throws. No `undefined` returns.

### 6.4 Rollback & Kill Switch

- Fingerprint files are version-controlled JSON. Rollback = revert the file commit.
- `version: "1.0"` is a Zod literal. A version increment requires changing the literal value — parse failure acts as the kill switch for mismatched file/code versions.
- No runtime feature flags in Phase 1.

### 6.5 Observability

- No internal logging in v1.0. Observability is the calling layer's responsibility.
- Thrown error classes carry structured metadata (`filePath`, `term`, `file1`, `file2`) for use by the caller's error handler or log formatter.

### 6.6 Phase 2 Deferrals

The following items from architecture §10 are explicitly out of scope for this spec and deferred to Phase 2:

- **Curation commands** (`fingerprint:suggest`, `fingerprint:review`, `fingerprint:compile`, `fingerprint:validate`) — the full CLI workflow described in architecture §10.3.
- **AI-assisted vocabulary extraction** — the reference-client weighting and `fingerprint:suggest` workflow from architecture §10.4.
- **Authoring automation** — any tooling that writes or modifies fingerprint JSON files programmatically.
- **Multi-level inheritance** — cell files extending other cell files. Shallow (one level) only in Phase 1.

The `resolvedAt` field in `ResolvedFingerprintSchema` is an addition beyond the architecture §10.3 sketch, added for cache invalidation and test utility. It does not change the merge semantics. Future Phase 2 work may use it for fingerprint-reload detection.

## 7. Test Scaffold Reference

See: specs/fingerprint/test-scaffold.md
