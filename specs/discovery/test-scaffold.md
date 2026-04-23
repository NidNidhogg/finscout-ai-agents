# TEST SCAFFOLD: XDiscoverySource
<!-- Companion to: specs/discovery/spec.md v1.0 -->
<!-- This document is stack-agnostic. It describes WHAT to test, not HOW. -->
<!-- This is a retroactive scaffold: all scenarios below correspond to existing tests in src/discovery/XDiscoverySource.test.ts. -->

---

## AC-001: extractKeywords detects funding-signal phrases in tweet text

### Happy Path — multiple funding-signal phrases matched
- **Input:** `makeTweet('We raised a seed round for our startup!')`
- **Expected Output:** `ExtractedKeywords` with `fundingSignals` containing both `"we raised"` and `"seed round"`
- **Assertions:**
  - `result.fundingSignals` contains `"we raised"`
  - `result.fundingSignals` contains `"seed round"`

---

## AC-002: extractKeywords detects both a funding-signal phrase and a sector keyword

### Happy Path — funding signal and sector keyword both matched
- **Input:** `makeTweet('Thrilled to announce our DeFi protocol launch')`
- **Expected Output:** `fundingSignals` contains `"thrilled to announce"`; `sectorKeywords` contains `"defi"`
- **Assertions:**
  - `result.fundingSignals` contains `"thrilled to announce"`
  - `result.sectorKeywords` contains `"defi"`

---

## AC-003: extractKeywords returns all-empty arrays for irrelevant tweet text

### Edge Case — no recognized vocabulary in tweet
- **Input:** `makeTweet('Great day for a walk in the park')`
- **Expected Output:** all three arrays empty
- **Assertions:**
  - `result.fundingSignals` has length 0
  - `result.sectorKeywords` has length 0
  - `result.all` has length 0

---

## AC-004: extractKeywords all field is the concatenation of fundingSignals and sectorKeywords

### Happy Path — all field mirrors both sub-arrays
- **Input:** `makeTweet('We raised seed funding for our fintech startup')`
- **Expected Output:** `all` contains every item in `fundingSignals` and every item in `sectorKeywords`; `all.length === fundingSignals.length + sectorKeywords.length`
- **Assertions:**
  - For every item in `result.fundingSignals`: `result.all` contains that item
  - For every item in `result.sectorKeywords`: `result.all` contains that item
  - `result.all.length === result.fundingSignals.length + result.sectorKeywords.length`

---

## AC-005: extractKeywords matching is case-insensitive

### Edge Case — uppercased tweet text matches same as lowercase
- **Input:** `makeTweet('THRILLED TO ANNOUNCE our FINTECH platform')`
- **Expected Output:** `fundingSignals` contains `"thrilled to announce"`; `sectorKeywords` contains `"fintech"`
- **Assertions:**
  - `result.fundingSignals` contains `"thrilled to announce"`
  - `result.sectorKeywords` contains `"fintech"`

---

## AC-006: extractKeywords throws ValidationError for invalid createdAt

### Edge Case — createdAt is not a parseable date string
- **Input:** `{ id: '1', text: 'hello', authorId: 'u1', createdAt: 'not-a-date' }`
- **Expected Output:** throws `ValidationError`
- **Assertions:**
  - Thrown error is instance of `ValidationError`
  - Error message contains `"createdAt"`

---

## AC-007: scoreTweet yields a priority score of at least 70 for combo input

### Happy Path — funding signals and sector keywords both present
- **Input:** `makeTweet('Thrilled to announce our fintech seed round!')`
- **Expected Output:** `priorityScore >= 70`
- **Assertions:**
  - `result.priorityScore >= 70`

---

## AC-008: scoreTweet yields a priority score of exactly 50 for funding signals only

### Happy Path — funding signals present, no sector keywords
- **Input:** `makeTweet('We just closed our round — very exciting news!')`
- **Expected Output:** `priorityScore === 50`
- **Assertions:**
  - `result.priorityScore === 50`

---

## AC-009: scoreTweet yields a priority score of exactly 30 for sector keywords only

### Happy Path — sector keywords present, no funding signals
- **Input:** `makeTweet('Building the future of DeFi and crypto')`
- **Expected Output:** `priorityScore === 30`
- **Assertions:**
  - `result.priorityScore === 30`

---

## AC-010: scoreTweet yields a priority score of exactly 0 for irrelevant tweet text

### Edge Case — no recognized vocabulary in tweet
- **Input:** `makeTweet('Lovely weather today, coffee is great')`
- **Expected Output:** `priorityScore === 0`
- **Assertions:**
  - `result.priorityScore === 0`

---

## AC-011: scoreTweet result carries tweetId and extracted signal metadata

### Happy Path — result shape includes source tweet identity and matched signals
- **Input:** `makeTweet('We raised seed funding for our fintech', '42')`
- **Expected Output:** `{ tweetId: '42', fundingSignals: [<non-empty>], sectorKeywords: ['fintech'], ... }`
- **Assertions:**
  - `result.tweetId === '42'`
  - `result.fundingSignals.length > 0`
  - `result.sectorKeywords` contains `"fintech"`

---

## AC-012: scoreTweet throws ValidationError for invalid createdAt

### Edge Case — createdAt is not a parseable date string
- **Input:** `{ id: '1', text: 'hello', authorId: 'u1', createdAt: 'not-a-date' }`
- **Expected Output:** throws `ValidationError`
- **Assertions:**
  - Thrown error is instance of `ValidationError`
  - Error message contains `"createdAt"`

---

## AC-013: buildLookAlikeQuery extracts sector keywords from founder bio

### Happy Path — bio contains sector-matching vocabulary
- **Input:** `makeProfile('DeFi protocol founder | building crypto infrastructure')`
- **Expected Output:** `keywords` contains `"defi"` and `"crypto"`
- **Assertions:**
  - `result.keywords` contains `"defi"`
  - `result.keywords` contains `"crypto"`

---

## AC-014: buildLookAlikeQuery includes explicit profile keywords in result

### Happy Path — explicit keywords present in profile
- **Input:** `makeProfile('serial entrepreneur', ['fintech', 'seed'])`
- **Expected Output:** `keywords` contains `"fintech"`
- **Assertions:**
  - `result.keywords` contains `"fintech"`

---

## AC-015: buildLookAlikeQuery queryString is non-empty, contains keywords, and uses OR as separator

### Happy Path — bio and explicit keywords both contribute
- **Input:** `makeProfile('Web3 founder | stablecoin builder', ['web3'])`
- **Expected Output:** non-empty `queryString` containing `"web3"`, `"stablecoin"`, and `"OR"`
- **Assertions:**
  - `result.queryString !== ""`
  - `result.queryString` contains `"web3"`
  - `result.queryString` contains `"stablecoin"`
  - `result.queryString` contains `"OR"`

---

## AC-016: buildLookAlikeQuery deduplicates keywords appearing in both bio and explicit list

### Edge Case — same keyword in bio and explicit list
- **Input:** `makeProfile('fintech startup founder', ['fintech'])`
- **Expected Output:** `"fintech"` appears exactly once in `keywords`
- **Assertions:**
  - `result.keywords.filter(k => k === 'fintech').length === 1`

---

## AC-017: buildLookAlikeQuery returns empty keywords and empty queryString for irrelevant profile

### Edge Case — bio and keywords contain no recognized vocabulary
- **Input:** `makeProfile('coffee lover | travel enthusiast')`
- **Expected Output:** `{ keywords: [], queryString: "" }`
- **Assertions:**
  - `result.keywords` has length 0
  - `result.queryString === ""`

---

## AC-018: buildLookAlikeQuery throws ValidationError for empty handle

### Edge Case — handle is an empty string
- **Input:** `{ handle: '', bio: 'something', keywords: [] }`
- **Expected Output:** throws `ValidationError`
- **Assertions:**
  - Thrown error is instance of `ValidationError`
  - Error message contains `"handle"`
