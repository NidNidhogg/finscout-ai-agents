# SPEC: Sales Factory Lead Qualification
<!-- spec-version: 1.0 -->
<!-- status: draft -->
<!-- signed-by: -->
<!-- date: 2026-04-15 -->
<!-- superseded-by: -->

## 1. Intent

The Sales Factory qualifies inbound company leads against a fixed set of hard gates and then scores survivors against intent signals to produce a ranked, actionable prospect list. Only companies that pass every hard gate enter the scoring pipeline; companies that fail any gate are immediately disqualified. The output drives outbound prioritization for the FinScout sales team.

## 2. Functional Contract

| Operation | Input Shape | Output Shape | Idempotent | Side Effects |
|-----------|-------------|--------------|------------|--------------|
| `qualifyLead` | `LeadInput` | `QualificationResult` | Yes | None |
| `scoreLead` | `QualifiedLead` | `ScoredLead` | Yes | None |
| `mapMVA` | `ScoredLead` | `ScoredLead` with `mvaRecommendations` | Yes | None |

## 3. Interface Contract

### `LeadInput`
```ts
{
  companyId:      string;          // unique identifier
  sector:         string;          // raw sector tag from data source
  stage:          string;          // funding stage label
  lastFundedAt:   string;          // ISO 8601 date
  headcount:      number;          // total employee count
  signals:        Signal[];        // array of detected intent signals
}
```

### `Signal`
```ts
{ type: "HIRING_TECH" | "LPR" | "SECURITY" | "OUTSTAFFING" }
```

### `QualificationResult`
```ts
{
  companyId:    string;
  status:       "QUALIFIED" | "DISQUALIFIED";
  failedGate?:  "SECTOR" | "STAGE" | "FUNDING_RECENCY" | "HEADCOUNT";
  lead?:        QualifiedLead;    // present only when status === "QUALIFIED"
}
```

### `ScoredLead`
```ts
{
  companyId:          string;
  score:              number;
  mvaRecommendations: string[];   // e.g. ["Security Layer (HSM/Multisig)"]
}
```

## 4. Boundary Contract

- Does NOT: fetch company data from external APIs; persist results to a database; send notifications.
- Assumes: `lastFundedAt` is a valid ISO 8601 date string; `headcount` is a positive integer.
- Depends on: system clock (for funding recency calculation).
- If system clock is unavailable: throw `ClockError`; do not silently default.

## 5. Acceptance Criteria

### Hard Gates (applied in order; first failure short-circuits)

- AC-001: A lead whose `sector` is NOT one of `Fintech | Web3 | Crypto | DeFi | Wallet | Stablecoin` (case-insensitive) must return `status: DISQUALIFIED, failedGate: SECTOR`.
- AC-002: A lead whose `stage` is NOT one of `Pre-Seed | Seed | Series A` (case-insensitive) must return `status: DISQUALIFIED, failedGate: STAGE`.
- AC-003: A lead whose `lastFundedAt` is more than 12 months before today OR less than 1 month before today must return `status: DISQUALIFIED, failedGate: FUNDING_RECENCY`.
- AC-004: A lead whose `headcount` is greater than 50 must return `status: DISQUALIFIED, failedGate: HEADCOUNT`.
- AC-005: A lead that passes all four gates must return `status: QUALIFIED` with the full `lead` payload.

### Scoring

- AC-006: A qualified lead with signal `HIRING_TECH` receives `+40` to its score.
- AC-007: A qualified lead with signal `LPR` receives `+30` to its score.
- AC-008: A qualified lead with signal `SECURITY` receives `+30` to its score.
- AC-009: A qualified lead with signal `OUTSTAFFING` receives `-50` to its score (penalty).
- AC-010: Score is the sum of all applicable signal adjustments; a lead with no signals scores `0`.
- AC-011: Multiple signals are additive; a lead with `HIRING_TECH` + `LPR` scores `+70`.

### MVA Mapping

- AC-012: A qualified lead in sector `DeFi` or `Wallet` must have `"Security Layer (HSM/Multisig)"` included in `mvaRecommendations`.
- AC-013: A qualified lead in any other passing sector must NOT have `"Security Layer (HSM/Multisig)"` in `mvaRecommendations` unless another rule adds it.

## 6. MVA Constraints

### 6.1 Security Boundaries

- All `LeadInput` fields are validated with Zod before any gate logic executes.
- `sector` and `stage` comparisons are case-insensitive to prevent bypass via casing.
- `companyId` is treated as an opaque string; no SQL/command interpolation is performed on it.

### 6.2 Resource Ceilings

- `qualifyLead`, `scoreLead`, and `mapMVA` are pure synchronous functions.
- No network calls, no file I/O, no database access.
- Maximum input payload: 4 KB per lead (enforced by upstream API layer).

### 6.3 Failure Modes & Degradation

- Invalid `LeadInput` (Zod parse failure): throw `ValidationError` with field-level messages; do not partially process.
- `lastFundedAt` unparseable as date: throw `ValidationError`; do not silently treat as disqualified.
- No partial qualification: a lead is either fully qualified or fully disqualified.

### 6.4 Rollback & Kill Switch

- This module is pure business logic with no persistent state; rollback = deploy previous version.
- No feature flags required for v1.0.

### 6.5 Observability

- Each `qualifyLead` call emits a structured log entry: `{ companyId, status, failedGate?, durationMs }`.
- Each `scoreLead` call emits: `{ companyId, score, signalsApplied[] }`.
- No external metrics sink required for v1.0; log output is sufficient.

## 7. Test Scaffold Reference

See: specs/sales-factory/test-scaffold.md
