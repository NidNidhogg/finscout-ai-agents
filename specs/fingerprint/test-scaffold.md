# TEST SCAFFOLD: Fingerprint Data Contract & Resolver
<!-- Companion to: specs/fingerprint/spec.md v1.0 -->
<!-- This document is stack-agnostic. It describes WHAT to test, not HOW. -->

---

<!--
Helper reference (stack-agnostic descriptions):

  makeCoreFile(overrides?) — returns a valid core fingerprint file object:
    version: '1.0', lastCurated: '2026-04-22', curator: 'dmitriy',
    primarySignals: [{ term: 'multisig', weight: 1.5 }],
    antiSignals: [{ term: 'airdrop', weight: 1.0 }].
    Top-level overrides spread onto base; nested fields (e.g. primarySignals)
    require full replacement since the override is a shallow spread.

  makeCellFile(overrides?) — returns a valid cell fingerprint file object:
    version: '1.0', lastCurated: '2026-04-22', curator: 'dmitriy',
    cell: 'DeFi & Yield',
    extends: ['core-web3-signals', 'core-web3-anti-signals'],
    primarySignals: [{ term: 'TVL', weight: 1.2 }],
    antiSignals: [{ term: 'rugpull', weight: 1.0 }].
    Top-level overrides spread onto base.

  Resolver tests (AC-009 to AC-025) use fixture files written to disk before
  the test runs and cleaned up after. Fixture directory mirrors the real layout:

    data/fixtures/fingerprints/
    ├── core-web3-signals.json
    ├── core-web3-anti-signals.json
    └── cells/
        └── defi-&-yield.json   (and other cell files as needed per test)

  The fixture base path is passed as the second argument to the resolver:
    resolveFingerprint('DeFi & Yield', 'data/fixtures/fingerprints')

  Each resolver test creates its own isolated fixture directory (e.g. via a
  temp directory or a uniquely-named subdirectory) to avoid cross-test
  interference, and removes it in afterEach/afterAll.
-->

---

## AC-001: CoreFingerprintFileSchema parses a valid core file object

### Happy Path — all required fields present, no extra fields

- **Input:** `makeCoreFile()`
- **Expected Output:** `CoreFingerprintFileSchema.parse(input)` returns without throwing
- **Assertions:**
  - `result.version === '1.0'`
  - `result.primarySignals[0].term === 'multisig'`

---

## AC-002: CellFingerprintFileSchema parses a valid cell file object

### Happy Path — all required fields including cell and extends present

- **Input:** `makeCellFile()`
- **Expected Output:** `CellFingerprintFileSchema.parse(input)` returns without throwing
- **Assertions:**
  - `result.cell === 'DeFi & Yield'`
  - `result.extends` contains `'core-web3-signals'` and `'core-web3-anti-signals'`

---

## AC-003: CoreFingerprintFileSchema rejects an object with an extends field

### Edge Case — .strict() rejects unrecognized fields

- **Input:** `makeCoreFile({ extends: ['core-web3-signals'] })`
- **Expected Output:** `CoreFingerprintFileSchema.parse(input)` throws `ZodError`
- **Assertions:**
  - Thrown error is an instance of `ZodError`

---

## AC-004: CellFingerprintFileSchema rejects an object missing the extends field

### Edge Case — required field absent

- **Input:** `makeCellFile()` with `extends` key removed entirely
- **Expected Output:** `CellFingerprintFileSchema.parse(input)` throws `ZodError`
- **Assertions:**
  - Thrown error is an instance of `ZodError`

---

## AC-005: CellFingerprintFileSchema rejects an extends array with fewer than 2 entries

### Edge Case — minimum length constraint violated

- **Input:** `makeCellFile({ extends: ['core-web3-signals'] })`
- **Expected Output:** `CellFingerprintFileSchema.parse(input)` throws `ZodError`
- **Assertions:**
  - Thrown error is an instance of `ZodError`
  - Error issues reference the `extends` path

---

## AC-006: CellFingerprintFileSchema rejects an object missing the cell field

### Edge Case — required field absent

- **Input:** `makeCellFile()` with `cell` key removed entirely
- **Expected Output:** `CellFingerprintFileSchema.parse(input)` throws `ZodError`
- **Assertions:**
  - Thrown error is an instance of `ZodError`

---

## AC-007: version set to any value other than "1.0" fails validation

### Edge Case — literal mismatch on both schemas

- **Input:** `makeCoreFile({ version: '2.0' })` and `makeCellFile({ version: '2.0' })`
- **Expected Output:** both `CoreFingerprintFileSchema.parse()` and `CellFingerprintFileSchema.parse()` throw `ZodError`
- **Assertions:**
  - Both calls throw `ZodError`
  - Error issues reference the `version` path

---

## AC-008: A signal entry with weight of 0, negative, or greater than 3 fails SignalSchema validation

### Edge Case — weight bounds enforced (0, 3]

- **Input (zero):** `makeCoreFile({ primarySignals: [{ term: 'test', weight: 0 }] })`
- **Input (negative):** `makeCoreFile({ primarySignals: [{ term: 'test', weight: -1 }] })`
- **Input (above max):** `makeCoreFile({ primarySignals: [{ term: 'test', weight: 3.1 }] })`
- **Expected Output:** all three calls throw `ZodError`
- **Assertions:**
  - All three calls throw `ZodError`
  - `makeCoreFile({ primarySignals: [{ term: 'test', weight: 3 }] })` parses successfully (3 is valid)

---

## AC-009: resolveFingerprint throws FingerprintValidationError when extends omits a required core name

### Edge Case — semantic extends rule violated

- **Setup:** write fixture files where `cells/defi-&-yield.json` has `extends: ['core-web3-signals']` (missing `core-web3-anti-signals`)
- **Input:** `resolveFingerprint('DeFi & Yield', fixturePath)`
- **Expected Output:** throws `FingerprintValidationError`
- **Assertions:**
  - Thrown error is an instance of `FingerprintValidationError`

---

## AC-010: resolveFingerprint throws FingerprintValidationError when extends contains a non-core name

### Edge Case — shallow-only enforcement; cell-extends-cell rejected

- **Setup:** write fixture files where `cells/defi-&-yield.json` has `extends: ['core-web3-signals', 'core-web3-anti-signals', 'cells/trading']`
- **Input:** `resolveFingerprint('DeFi & Yield', fixturePath)`
- **Expected Output:** throws `FingerprintValidationError`
- **Assertions:**
  - Thrown error is an instance of `FingerprintValidationError`

---

## AC-011: resolveFingerprint throws FingerprintNotFoundError when a file in extends does not exist

### Edge Case — referenced file absent from filesystem

- **Setup:** write fixture files where `cells/defi-&-yield.json` has `extends: ['core-web3-signals', 'core-web3-anti-signals', 'nonexistent']` AND a file named `nonexistent.json` is not present in `fixturePath`
- **Input:** `resolveFingerprint('DeFi & Yield', fixturePath)`
- **Expected Output:** throws `FingerprintNotFoundError`
- **Assertions:**
  - Thrown error is an instance of `FingerprintNotFoundError`
  - `error.filePath` contains `'nonexistent'`

---

## AC-012: Cell signal overrides core signal on term collision

### Happy Path — cell entry wins; core entry replaced

- **Setup:** write fixture files where `core-web3-signals.json` has `primarySignals: [{ term: 'multisig', weight: 1.0 }]` and `cells/defi-&-yield.json` has `primarySignals: [{ term: 'multisig', weight: 2.5, notes: 'cell override' }]`
- **Input:** `resolveFingerprint('DeFi & Yield', fixturePath)`
- **Expected Output:** resolved `primarySignals` contains `'multisig'` exactly once with `weight: 2.5`
- **Assertions:**
  - `result.primarySignals.filter(s => s.term === 'multisig').length === 1`
  - `result.primarySignals.find(s => s.term === 'multisig').weight === 2.5`

---

## AC-013: resolveFingerprint throws FingerprintCollisionError on cross-core term collision

### Edge Case — same term in both core files' primarySignals

- **Setup:** write fixture files where `core-web3-signals.json` has `primarySignals: [{ term: 'audit', weight: 1.5 }]` and `core-web3-anti-signals.json` also has `primarySignals: [{ term: 'audit', weight: 1.0 }]`
- **Input:** `resolveFingerprint('DeFi & Yield', fixturePath)`
- **Expected Output:** throws `FingerprintCollisionError`
- **Assertions:**
  - Thrown error is an instance of `FingerprintCollisionError`
  - `error.term === 'audit'`

---

## AC-014: resolveFingerprint returns a ResolvedFingerprint given valid fixture files

### Happy Path — all three files present, valid, no collisions

- **Setup:** write minimal valid fixture files: `core-web3-signals.json` (one primary signal), `core-web3-anti-signals.json` (one anti-signal), `cells/defi-&-yield.json` (one primary, one anti, extends both core names)
- **Input:** `resolveFingerprint('DeFi & Yield', fixturePath)`
- **Expected Output:** function resolves without throwing; returns a `ResolvedFingerprint`
- **Assertions:**
  - Returned object is not `undefined`
  - `result.cell === 'DeFi & Yield'`

---

## AC-015: Resolved primarySignals contains terms from both core and cell files

### Happy Path — union of all primarySignals sources

- **Setup:** write fixture files with non-overlapping terms: core has `primarySignals: [{ term: 'multisig', weight: 1.5 }]`; cell has `primarySignals: [{ term: 'TVL', weight: 1.2 }]`
- **Input:** `resolveFingerprint('DeFi & Yield', fixturePath)`
- **Expected Output:** `result.primarySignals` contains both `'multisig'` and `'TVL'`
- **Assertions:**
  - `result.primarySignals.map(s => s.term)` contains `'multisig'`
  - `result.primarySignals.map(s => s.term)` contains `'TVL'`

---

## AC-016: Resolved antiSignals contains terms from both core and cell files

### Happy Path — union of all antiSignals sources

- **Setup:** write fixture files with non-overlapping anti-signal terms: core has `antiSignals: [{ term: 'airdrop', weight: 1.0 }]`; cell has `antiSignals: [{ term: 'rugpull', weight: 1.0 }]`
- **Input:** `resolveFingerprint('DeFi & Yield', fixturePath)`
- **Expected Output:** `result.antiSignals` contains both `'airdrop'` and `'rugpull'`
- **Assertions:**
  - `result.antiSignals.map(s => s.term)` contains `'airdrop'`
  - `result.antiSignals.map(s => s.term)` contains `'rugpull'`

---

## AC-017: ResolvedFingerprint.cell equals the CompetencyCell value passed to resolveFingerprint

### Happy Path — cell identity preserved in output

- **Setup:** valid fixture files for `'DeFi & Yield'`
- **Input:** `resolveFingerprint('DeFi & Yield', fixturePath)`
- **Expected Output:** `result.cell === 'DeFi & Yield'`
- **Assertions:**
  - `result.cell === 'DeFi & Yield'`

---

## AC-018: resolveFingerprint throws FingerprintNotFoundError when a core file is absent

### Edge Case — core file missing from basePath

- **Setup:** fixture directory contains only `core-web3-anti-signals.json` and `cells/defi-&-yield.json`; `core-web3-signals.json` is absent
- **Input:** `resolveFingerprint('DeFi & Yield', fixturePath)`
- **Expected Output:** throws `FingerprintNotFoundError`
- **Assertions:**
  - Thrown error is an instance of `FingerprintNotFoundError`
  - `error.filePath` contains `'core-web3-signals'`

---

## AC-019: resolveFingerprint throws FingerprintNotFoundError when the cell file is absent

### Edge Case — cell file missing from basePath/cells/

- **Setup:** fixture directory contains both core files; `cells/defi-&-yield.json` is absent
- **Input:** `resolveFingerprint('DeFi & Yield', fixturePath)`
- **Expected Output:** throws `FingerprintNotFoundError`
- **Assertions:**
  - Thrown error is an instance of `FingerprintNotFoundError`
  - `error.filePath` contains `'defi-&-yield'`

---

## AC-020: resolveFingerprint throws FingerprintValidationError when any file contains malformed JSON

### Edge Case — JSON.parse failure propagated as FingerprintValidationError

- **Setup:** write `core-web3-signals.json` with content `{ invalid json` (not parseable)
- **Input:** `resolveFingerprint('DeFi & Yield', fixturePath)`
- **Expected Output:** throws `FingerprintValidationError`
- **Assertions:**
  - Thrown error is an instance of `FingerprintValidationError`
  - `error.filePath` contains `'core-web3-signals'`

---

## AC-021: resolveFingerprint throws FingerprintValidationError when any file fails Zod schema validation

### Edge Case — valid JSON but schema-invalid content propagated as FingerprintValidationError

- **Setup:** write `core-web3-signals.json` as valid JSON with `primarySignals: [{ term: 'test', weight: -1 }]` (weight violates positive constraint)
- **Input:** `resolveFingerprint('DeFi & Yield', fixturePath)`
- **Expected Output:** throws `FingerprintValidationError`
- **Assertions:**
  - Thrown error is an instance of `FingerprintValidationError`
  - `error.filePath` contains `'core-web3-signals'`

---

## AC-022: The object returned by resolveFingerprint validates against ResolvedFingerprintSchema

### Happy Path — output shape is schema-valid

- **Setup:** valid minimal fixture files
- **Input:** `resolveFingerprint('DeFi & Yield', fixturePath)`
- **Expected Output:** `ResolvedFingerprintSchema.parse(result)` does not throw
- **Assertions:**
  - `expect(() => ResolvedFingerprintSchema.parse(result)).not.toThrow()`

---

## AC-023: All signals in the resolved output have weight strictly within (0, 3]

### Happy Path — weight bounds preserved through merge

- **Setup:** fixture files using representative weights (e.g. 0.5, 1.0, 1.5, 2.0, 3.0)
- **Input:** `resolveFingerprint('DeFi & Yield', fixturePath)`
- **Expected Output:** every signal in `primarySignals` and `antiSignals` has `weight > 0` and `weight <= 3`
- **Assertions:**
  - `result.primarySignals.every(s => s.weight > 0 && s.weight <= 3)` is `true`
  - `result.antiSignals.every(s => s.weight > 0 && s.weight <= 3)` is `true`

---

## AC-024: No term appears more than once in the resolved primarySignals or antiSignals

### Happy Path — merge algorithm produces unique terms per array

- **Setup:** fixture files with overlapping terms between core and cell (e.g. `'multisig'` in both core primary and cell primary)
- **Input:** `resolveFingerprint('DeFi & Yield', fixturePath)`
- **Expected Output:** each term appears exactly once in `primarySignals`; each term appears exactly once in `antiSignals`
- **Assertions:**
  - `new Set(result.primarySignals.map(s => s.term)).size === result.primarySignals.length`
  - `new Set(result.antiSignals.map(s => s.term)).size === result.antiSignals.length`

---

## AC-025: ResolvedFingerprint.resolvedAt is a valid ISO 8601 datetime string

### Happy Path — resolvedAt populated at call time

- **Setup:** valid minimal fixture files; record the time just before the call
- **Input:** `resolveFingerprint('DeFi & Yield', fixturePath)`
- **Expected Output:** `result.resolvedAt` is a non-empty ISO 8601 datetime string; its parsed date is at or after the recorded pre-call time
- **Assertions:**
  - `result.resolvedAt` is a non-empty string
  - `new Date(result.resolvedAt).getTime()` does not return `NaN`
  - `new Date(result.resolvedAt) >= preCallTime`
