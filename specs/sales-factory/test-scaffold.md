# TEST SCAFFOLD: Sales Factory Lead Qualification
<!-- Companion to: specs/sales-factory/spec.md v1.0 -->
<!-- This document is stack-agnostic. It describes WHAT to test, not HOW. -->
<!-- The execution layer translates this into Jest + ts-jest test code. -->

---

## AC-001: Sector gate rejects leads outside the allowed set

### Happy Path — valid sector passes
- **Input:** `{ sector: "Fintech", stage: "Seed", lastFundedAt: <3 months ago>, headcount: 20, signals: [] }`
- **Expected Output:** `{ status: "QUALIFIED" }`
- **Assertions:**
  - `result.status === "QUALIFIED"`
  - `result.failedGate` is undefined

### Happy Path — all valid sectors pass
- **Input:** one lead per sector: `Fintech`, `Web3`, `Crypto`, `DeFi`, `Wallet`, `Stablecoin`
- **Expected Output:** all return `status: "QUALIFIED"`
- **Assertions:**
  - None of the six results have `failedGate === "SECTOR"`

### Edge Case — case-insensitive match
- **Input:** `{ sector: "fintech" }` (lowercase), all other fields valid
- **Expected Output:** `{ status: "QUALIFIED" }`
- **Assertions:**
  - `result.status === "QUALIFIED"`

### Edge Case — unknown sector is rejected
- **Input:** `{ sector: "SaaS" }`, all other fields valid
- **Expected Output:** `{ status: "DISQUALIFIED", failedGate: "SECTOR" }`
- **Assertions:**
  - `result.status === "DISQUALIFIED"`
  - `result.failedGate === "SECTOR"`
  - `result.lead` is undefined

### Edge Case — empty string sector
- **Input:** `{ sector: "" }`, all other fields valid
- **Expected Output:** `{ status: "DISQUALIFIED", failedGate: "SECTOR" }`
- **Assertions:**
  - `result.failedGate === "SECTOR"`

---

## AC-002: Stage gate rejects leads outside Pre-Seed / Seed / Series A

### Happy Path — valid stage passes
- **Input:** `{ stage: "Seed" }`, all other fields valid
- **Expected Output:** `{ status: "QUALIFIED" }`
- **Assertions:**
  - `result.status === "QUALIFIED"`

### Happy Path — all valid stages pass
- **Input:** three leads with stages `Pre-Seed`, `Seed`, `Series A`
- **Expected Output:** all `status: "QUALIFIED"`
- **Assertions:**
  - No result has `failedGate === "STAGE"`

### Edge Case — Series B is rejected
- **Input:** `{ stage: "Series B" }`, all other fields valid
- **Expected Output:** `{ status: "DISQUALIFIED", failedGate: "STAGE" }`
- **Assertions:**
  - `result.failedGate === "STAGE"`

### Edge Case — case-insensitive match
- **Input:** `{ stage: "series a" }`, all other fields valid
- **Expected Output:** `{ status: "QUALIFIED" }`
- **Assertions:**
  - `result.status === "QUALIFIED"`

---

## AC-003: Funding Recency gate rejects leads funded outside the 1–12 month window

### Happy Path — funded 3 months ago passes
- **Input:** `{ lastFundedAt: <today minus 90 days> }`, all other fields valid
- **Expected Output:** `{ status: "QUALIFIED" }`
- **Assertions:**
  - `result.status === "QUALIFIED"`

### Edge Case — funded 13 months ago is rejected
- **Input:** `{ lastFundedAt: <today minus 395 days> }`, all other fields valid
- **Expected Output:** `{ status: "DISQUALIFIED", failedGate: "FUNDING_RECENCY" }`
- **Assertions:**
  - `result.failedGate === "FUNDING_RECENCY"`

### Edge Case — funded 2 weeks ago is rejected (too recent)
- **Input:** `{ lastFundedAt: <today minus 14 days> }`, all other fields valid
- **Expected Output:** `{ status: "DISQUALIFIED", failedGate: "FUNDING_RECENCY" }`
- **Assertions:**
  - `result.failedGate === "FUNDING_RECENCY"`

### Edge Case — funded exactly 12 months ago (boundary — inclusive)
- **Input:** `{ lastFundedAt: <today minus 365 days> }`, all other fields valid
- **Expected Output:** `{ status: "QUALIFIED" }`
- **Assertions:**
  - `result.status === "QUALIFIED"`

### Edge Case — funded exactly 1 month ago (boundary — inclusive)
- **Input:** `{ lastFundedAt: <today minus 30 days> }`, all other fields valid
- **Expected Output:** `{ status: "QUALIFIED" }`
- **Assertions:**
  - `result.status === "QUALIFIED"`

### Edge Case — invalid date string throws ValidationError
- **Input:** `{ lastFundedAt: "not-a-date" }`, all other fields valid
- **Expected Output:** throws `ValidationError`
- **Assertions:**
  - Error type is `ValidationError`
  - Error message references `lastFundedAt`

---

## AC-004: Headcount gate rejects leads with more than 50 employees

### Happy Path — headcount 50 passes
- **Input:** `{ headcount: 50 }`, all other fields valid
- **Expected Output:** `{ status: "QUALIFIED" }`
- **Assertions:**
  - `result.status === "QUALIFIED"`

### Edge Case — headcount 51 is rejected
- **Input:** `{ headcount: 51 }`, all other fields valid
- **Expected Output:** `{ status: "DISQUALIFIED", failedGate: "HEADCOUNT" }`
- **Assertions:**
  - `result.failedGate === "HEADCOUNT"`

### Edge Case — headcount 1 passes
- **Input:** `{ headcount: 1 }`, all other fields valid
- **Expected Output:** `{ status: "QUALIFIED" }`
- **Assertions:**
  - `result.status === "QUALIFIED"`

---

## AC-005: A lead passing all four gates is QUALIFIED with full payload

### Happy Path — all gates pass
- **Input:** `{ sector: "Crypto", stage: "Pre-Seed", lastFundedAt: <6 months ago>, headcount: 10, signals: [] }`
- **Expected Output:** `{ status: "QUALIFIED", lead: { ...full LeadInput fields } }`
- **Assertions:**
  - `result.status === "QUALIFIED"`
  - `result.lead.companyId` equals input `companyId`
  - `result.failedGate` is undefined

---

## AC-006 – AC-011: Scoring signal accumulation

### Happy Path — HIRING_TECH yields +40
- **Input:** qualified lead, `signals: [{ type: "HIRING_TECH" }]`
- **Expected Output:** `{ score: 40 }`
- **Assertions:**
  - `result.score === 40`

### Happy Path — LPR yields +30
- **Input:** qualified lead, `signals: [{ type: "LPR" }]`
- **Expected Output:** `{ score: 30 }`
- **Assertions:**
  - `result.score === 30`

### Happy Path — SECURITY yields +30
- **Input:** qualified lead, `signals: [{ type: "SECURITY" }]`
- **Expected Output:** `{ score: 30 }`
- **Assertions:**
  - `result.score === 30`

### Happy Path — OUTSTAFFING yields -50
- **Input:** qualified lead, `signals: [{ type: "OUTSTAFFING" }]`
- **Expected Output:** `{ score: -50 }`
- **Assertions:**
  - `result.score === -50`

### Happy Path — no signals yields 0
- **Input:** qualified lead, `signals: []`
- **Expected Output:** `{ score: 0 }`
- **Assertions:**
  - `result.score === 0`

### Happy Path — HIRING_TECH + LPR yields +70
- **Input:** qualified lead, `signals: [{ type: "HIRING_TECH" }, { type: "LPR" }]`
- **Expected Output:** `{ score: 70 }`
- **Assertions:**
  - `result.score === 70`

### Edge Case — all signals combined: HIRING_TECH + LPR + SECURITY + OUTSTAFFING = +50
- **Input:** qualified lead, all four signal types
- **Expected Output:** `{ score: 50 }` (40 + 30 + 30 − 50)
- **Assertions:**
  - `result.score === 50`

---

## AC-012: MVA Mapping — DeFi and Wallet sectors trigger Security Layer recommendation

### Happy Path — DeFi triggers Security Layer
- **Input:** scored lead with `sector: "DeFi"`
- **Expected Output:** `mvaRecommendations` contains `"Security Layer (HSM/Multisig)"`
- **Assertions:**
  - `result.mvaRecommendations.includes("Security Layer (HSM/Multisig)") === true`

### Happy Path — Wallet triggers Security Layer
- **Input:** scored lead with `sector: "Wallet"`
- **Expected Output:** `mvaRecommendations` contains `"Security Layer (HSM/Multisig)"`
- **Assertions:**
  - `result.mvaRecommendations.includes("Security Layer (HSM/Multisig)") === true`

### Edge Case — case-insensitive sector match for MVA
- **Input:** scored lead with `sector: "wallet"` (lowercase)
- **Expected Output:** `mvaRecommendations` contains `"Security Layer (HSM/Multisig)"`
- **Assertions:**
  - `result.mvaRecommendations.includes("Security Layer (HSM/Multisig)") === true`

---

## AC-013: MVA Mapping — non-DeFi/Wallet sectors do NOT receive Security Layer recommendation

### Happy Path — Fintech does not trigger Security Layer
- **Input:** scored lead with `sector: "Fintech"`
- **Expected Output:** `mvaRecommendations` does NOT contain `"Security Layer (HSM/Multisig)"`
- **Assertions:**
  - `result.mvaRecommendations.includes("Security Layer (HSM/Multisig)") === false`

### Happy Path — each remaining sector (Web3, Crypto, Stablecoin) does not trigger Security Layer
- **Input:** three scored leads with sectors `Web3`, `Crypto`, `Stablecoin`
- **Expected Output:** none contain `"Security Layer (HSM/Multisig)"`
- **Assertions:**
  - All three `mvaRecommendations` arrays do not include `"Security Layer (HSM/Multisig)"`
