# TEST SCAFFOLD: EnrichedProfile
<!-- Companion to: specs/enriched-profile/spec.md v1.0 -->
<!-- This document is stack-agnostic. It describes WHAT to test, not HOW. -->

---

<!-- Helper reference (stack-agnostic descriptions):
  makeProfile(overrides?) — returns a minimal valid EnrichedProfile payload with all required fields set;
    id: valid UUID, enrichedAt: valid ISO 8601 datetime, schemaVersion: "1.0.0",
    sources: {}, company: { name: "Acme DeFi", normalizedName: "acme-defi", websiteUrl: "https://acmedefi.io" },
    funding: { claimed: {} }, product: { stackMentions: [], architectureTerms: [], antiSignalTerms: [],
    competencyCellMatches: [], evidence: [] }, team: { founders: [] }, rawContent: { websiteMarkdown: {} }.
    Top-level overrides are spread onto the base; for nested overrides supply the full sub-object.

  makeAnnotation(overrides?) — returns a minimal valid ReviewAnnotation payload with all required fields set;
    profileId: valid UUID, reviewedAt: valid ISO 8601 datetime, reviewedBy: "analyst-1",
    profileAdequate: true, missingEvidenceTypes: [], tier: "A",
    tierReason: "Strong DeFi signal", crunchbaseCheck: { checked: false }.
    Top-level overrides are spread onto the base.
-->

---

## AC-001: EnrichedProfile parses successfully with a valid UUID id

### Happy Path — valid UUID accepted

- **Input:** `makeProfile({ id: '123e4567-e89b-12d3-a456-426614174000' })`
- **Expected Output:** `EnrichedProfileSchema.parse(input)` returns without throwing
- **Assertions:**
  - `result.id === '123e4567-e89b-12d3-a456-426614174000'`

---

## AC-002: EnrichedProfile fails validation when id is not a valid UUID

### Edge Case — non-UUID id rejected

- **Input:** `makeProfile({ id: 'not-a-uuid' })`
- **Expected Output:** `EnrichedProfileSchema.parse(input)` throws `ZodError`
- **Assertions:**
  - Thrown error is an instance of `ZodError`
  - Error issues contain a path referencing `"id"`

---

## AC-003: EnrichedProfile parses successfully with a valid ISO 8601 enrichedAt

### Happy Path — valid datetime accepted

- **Input:** `makeProfile({ enrichedAt: '2026-04-22T00:00:00.000Z' })`
- **Expected Output:** `EnrichedProfileSchema.parse(input)` returns without throwing
- **Assertions:**
  - `result.enrichedAt === '2026-04-22T00:00:00.000Z'`

---

## AC-004: EnrichedProfile fails validation when enrichedAt is not a valid ISO 8601 datetime

### Edge Case — non-datetime enrichedAt rejected

- **Input:** `makeProfile({ enrichedAt: 'not-a-date' })`
- **Expected Output:** `EnrichedProfileSchema.parse(input)` throws `ZodError`
- **Assertions:**
  - Thrown error is an instance of `ZodError`
  - Error issues contain a path referencing `"enrichedAt"`

---

## AC-005: EnrichedProfile parses successfully when schemaVersion is "1.0.0"

### Happy Path — literal schemaVersion accepted

- **Input:** `makeProfile({ schemaVersion: '1.0.0' })`
- **Expected Output:** `EnrichedProfileSchema.parse(input)` returns without throwing
- **Assertions:**
  - `result.schemaVersion === '1.0.0'`

---

## AC-006: EnrichedProfile fails validation when schemaVersion is not "1.0.0"

### Edge Case — any other schemaVersion value rejected

- **Input:** `makeProfile({ schemaVersion: '2.0.0' })` (also verify with `'1.0'`)
- **Expected Output:** `EnrichedProfileSchema.parse(input)` throws `ZodError`
- **Assertions:**
  - Thrown error is an instance of `ZodError`
  - Error issues contain a path referencing `"schemaVersion"`

---

## AC-007: EnrichedProfile parses successfully with sources as an empty object

### Happy Path — partial enrichment state accepted

- **Input:** `makeProfile({ sources: {} })`
- **Expected Output:** `EnrichedProfileSchema.parse(input)` returns without throwing
- **Assertions:**
  - `result.sources` deep-equals `{}`

---

## AC-008: EnrichedProfile parses successfully with a fully populated sources.xApi object

### Happy Path — all xApi required sub-fields present

- **Input:** `makeProfile({ sources: { xApi: { lastFetched: '2026-04-22T00:00:00.000Z', tweetsConsidered: 12, founderHandle: '@alice' } } })`
- **Expected Output:** `EnrichedProfileSchema.parse(input)` returns without throwing
- **Assertions:**
  - `result.sources.xApi.tweetsConsidered === 12`
  - `result.sources.xApi.founderHandle === '@alice'`

---

## AC-009: EnrichedProfile fails validation when sources.xApi.tweetsConsidered is negative

### Edge Case — negative integer rejected by nonnegative constraint

- **Input:** `makeProfile({ sources: { xApi: { lastFetched: '2026-04-22T00:00:00.000Z', tweetsConsidered: -1 } } })`
- **Expected Output:** `EnrichedProfileSchema.parse(input)` throws `ZodError`
- **Assertions:**
  - Thrown error is an instance of `ZodError`
  - Error issues contain a path referencing `"tweetsConsidered"`

---

## AC-010: EnrichedProfile parses successfully with a fully populated sources.websiteCrawl object

### Happy Path — all websiteCrawl required sub-fields present

- **Input:** `makeProfile({ sources: { websiteCrawl: { lastFetched: '2026-04-22T00:00:00.000Z', pagesCrawled: ['https://acmedefi.io/about'], fetcher: 'firecrawl' } } })`
- **Expected Output:** `EnrichedProfileSchema.parse(input)` returns without throwing
- **Assertions:**
  - `result.sources.websiteCrawl.fetcher === 'firecrawl'`
  - `result.sources.websiteCrawl.pagesCrawled` has length 1

---

## AC-011: EnrichedProfile fails validation when a sources.websiteCrawl.pagesCrawled entry is not a valid URL

### Edge Case — non-URL string rejected in URL array

- **Input:** `makeProfile({ sources: { websiteCrawl: { lastFetched: '2026-04-22T00:00:00.000Z', pagesCrawled: ['not-a-url'], fetcher: 'firecrawl' } } })`
- **Expected Output:** `EnrichedProfileSchema.parse(input)` throws `ZodError`
- **Assertions:**
  - Thrown error is an instance of `ZodError`
  - Error issues contain a path referencing `"pagesCrawled"`

---

## AC-012: EnrichedProfile fails validation when company.name is an empty string

### Edge Case — empty name rejected by min(1) constraint

- **Input:** `makeProfile({ company: { name: '', normalizedName: 'acme-defi', websiteUrl: 'https://acmedefi.io' } })`
- **Expected Output:** `EnrichedProfileSchema.parse(input)` throws `ZodError`
- **Assertions:**
  - Thrown error is an instance of `ZodError`
  - Error issues contain a path referencing `"name"`

---

## AC-013: EnrichedProfile fails validation when company.websiteUrl is not a valid URL

### Edge Case — non-URL string rejected

- **Input:** `makeProfile({ company: { name: 'Acme DeFi', normalizedName: 'acme-defi', websiteUrl: 'not-a-url' } })`
- **Expected Output:** `EnrichedProfileSchema.parse(input)` throws `ZodError`
- **Assertions:**
  - Thrown error is an instance of `ZodError`
  - Error issues contain a path referencing `"websiteUrl"`

---

## AC-014: EnrichedProfile fails validation when company.linkedinUrl is present but not a valid URL

### Edge Case — optional URL field still validated when provided

- **Input:** `makeProfile({ company: { name: 'Acme DeFi', normalizedName: 'acme-defi', websiteUrl: 'https://acmedefi.io', linkedinUrl: 'not-a-url' } })`
- **Expected Output:** `EnrichedProfileSchema.parse(input)` throws `ZodError`
- **Assertions:**
  - Thrown error is an instance of `ZodError`
  - Error issues contain a path referencing `"linkedinUrl"`

---

## AC-015: EnrichedProfile parses successfully when funding.claimed has all optional fields omitted

### Happy Path — minimal claimed object accepted

- **Input:** `makeProfile({ funding: { claimed: {} } })`
- **Expected Output:** `EnrichedProfileSchema.parse(input)` returns without throwing
- **Assertions:**
  - `result.funding.claimed` deep-equals `{}`
  - `result.funding.confirmed` is `undefined`

---

## AC-016: EnrichedProfile fails validation when funding.claimed.amountUSD is zero or negative

### Edge Case — non-positive amount rejected

- **Input:** `makeProfile({ funding: { claimed: { amountUSD: 0 } } })` (also verify with `-1000`)
- **Expected Output:** `EnrichedProfileSchema.parse(input)` throws `ZodError`
- **Assertions:**
  - Thrown error is an instance of `ZodError`
  - Error issues contain a path referencing `"amountUSD"`

---

## AC-017: EnrichedProfile fails validation when funding.claimed.stage is not a valid FundingStage value

### Edge Case — unrecognized enum value rejected

- **Input:** `makeProfile({ funding: { claimed: { stage: 'series-z' } } })`
- **Expected Output:** `EnrichedProfileSchema.parse(input)` throws `ZodError`
- **Assertions:**
  - Thrown error is an instance of `ZodError`
  - Error issues contain a path referencing `"stage"`

---

## AC-018: EnrichedProfile parses successfully when funding.confirmed is present with foundInCrunchbase as a boolean

### Happy Path — optional confirmed block accepted

- **Input:** `makeProfile({ funding: { claimed: {}, confirmed: { foundInCrunchbase: true } } })`
- **Expected Output:** `EnrichedProfileSchema.parse(input)` returns without throwing
- **Assertions:**
  - `result.funding.confirmed.foundInCrunchbase === true`

---

## AC-019: EnrichedProfile fails validation when funding.confirmed.leadTimeDays is negative

### Edge Case — negative integer rejected by nonnegative constraint

- **Input:** `makeProfile({ funding: { claimed: {}, confirmed: { foundInCrunchbase: false, leadTimeDays: -5 } } })`
- **Expected Output:** `EnrichedProfileSchema.parse(input)` throws `ZodError`
- **Assertions:**
  - Thrown error is an instance of `ZodError`
  - Error issues contain a path referencing `"leadTimeDays"`

---

## AC-020: EnrichedProfile fails validation when a competencyCellMatches entry has an invalid cell value

### Edge Case — unrecognized CompetencyCell enum value rejected

- **Input:** `makeProfile({ product: { stackMentions: [], architectureTerms: [], antiSignalTerms: [], competencyCellMatches: [{ cell: 'InvalidCell', matchedSignals: [], matchedCoreSignals: [], score: 0.5 }], evidence: [] } })`
- **Expected Output:** `EnrichedProfileSchema.parse(input)` throws `ZodError`
- **Assertions:**
  - Thrown error is an instance of `ZodError`
  - Error issues contain a path referencing `"cell"`

---

## AC-021: EnrichedProfile fails validation when a competencyCellMatches entry has a score outside [0, 1]

### Edge Case — out-of-range score rejected

- **Input:** `makeProfile({ product: { stackMentions: [], architectureTerms: [], antiSignalTerms: [], competencyCellMatches: [{ cell: 'DeFi & Yield', matchedSignals: [], matchedCoreSignals: [], score: 1.5 }], evidence: [] } })` (also verify with `-0.1`)
- **Expected Output:** `EnrichedProfileSchema.parse(input)` throws `ZodError`
- **Assertions:**
  - Thrown error is an instance of `ZodError`
  - Error issues contain a path referencing `"score"`

---

## AC-022: EnrichedProfile fails validation when a product.evidence entry has an invalid relevance value

### Edge Case — unrecognized relevance enum value rejected

- **Input:** `makeProfile({ product: { stackMentions: [], architectureTerms: [], antiSignalTerms: [], competencyCellMatches: [], evidence: [{ page: 'https://acmedefi.io', snippet: 'test', relevance: 'critical' }] } })`
- **Expected Output:** `EnrichedProfileSchema.parse(input)` throws `ZodError`
- **Assertions:**
  - Thrown error is an instance of `ZodError`
  - Error issues contain a path referencing `"relevance"`

---

## AC-023: EnrichedProfile fails validation when a product.evidence entry has a non-URL page value

### Edge Case — non-URL page field rejected

- **Input:** `makeProfile({ product: { stackMentions: [], architectureTerms: [], antiSignalTerms: [], competencyCellMatches: [], evidence: [{ page: 'not-a-url', snippet: 'test', relevance: 'high' }] } })`
- **Expected Output:** `EnrichedProfileSchema.parse(input)` throws `ZodError`
- **Assertions:**
  - Thrown error is an instance of `ZodError`
  - Error issues contain a path referencing `"page"`

---

## AC-024: EnrichedProfile parses successfully when team.founders is an empty array

### Happy Path — no-founder state accepted

- **Input:** `makeProfile({ team: { founders: [] } })`
- **Expected Output:** `EnrichedProfileSchema.parse(input)` returns without throwing
- **Assertions:**
  - `result.team.founders` has length 0

---

## AC-025: EnrichedProfile fails validation when a team.openRoles entry has an empty string title

### Edge Case — empty title rejected by min(1) constraint

- **Input:** `makeProfile({ team: { founders: [], openRoles: [{ title: '', stackHints: [] }] } })`
- **Expected Output:** `EnrichedProfileSchema.parse(input)` throws `ZodError`
- **Assertions:**
  - Thrown error is an instance of `ZodError`
  - Error issues contain a path referencing `"title"`

---

## AC-026: EnrichedProfile fails validation when a team.openRoles entry has an invalid seniority value

### Edge Case — unrecognized seniority enum value rejected

- **Input:** `makeProfile({ team: { founders: [], openRoles: [{ title: 'Engineer', stackHints: [], seniority: 'principal' }] } })`
- **Expected Output:** `EnrichedProfileSchema.parse(input)` throws `ZodError`
- **Assertions:**
  - Thrown error is an instance of `ZodError`
  - Error issues contain a path referencing `"seniority"`

---

## AC-027: EnrichedProfile parses successfully when rawContent.websiteMarkdown is an empty record

### Happy Path — empty markdown map accepted

- **Input:** `makeProfile({ rawContent: { websiteMarkdown: {} } })`
- **Expected Output:** `EnrichedProfileSchema.parse(input)` returns without throwing
- **Assertions:**
  - `result.rawContent.websiteMarkdown` deep-equals `{}`
  - `result.rawContent.sourceTweets` is `undefined`

---

## AC-028: EnrichedProfile fails validation when a rawContent.sourceTweets entry has an empty string id

### Edge Case — empty tweet id rejected by min(1) constraint

- **Input:** `makeProfile({ rawContent: { websiteMarkdown: {}, sourceTweets: [{ id: '', text: 'hello', postedAt: '2026-04-22T00:00:00.000Z', authorHandle: '@alice' }] } })`
- **Expected Output:** `EnrichedProfileSchema.parse(input)` throws `ZodError`
- **Assertions:**
  - Thrown error is an instance of `ZodError`
  - Error issues contain a path referencing `"id"`

---

## AC-029: EnrichedProfile fails validation when a rawContent.sourceTweets entry has a non-ISO-8601 postedAt value

### Edge Case — non-datetime string rejected

- **Input:** `makeProfile({ rawContent: { websiteMarkdown: {}, sourceTweets: [{ id: '1', text: 'hello', postedAt: 'yesterday', authorHandle: '@alice' }] } })`
- **Expected Output:** `EnrichedProfileSchema.parse(input)` throws `ZodError`
- **Assertions:**
  - Thrown error is an instance of `ZodError`
  - Error issues contain a path referencing `"postedAt"`

---

## AC-030: ReviewAnnotation fails validation when profileId is not a valid UUID

### Edge Case — non-UUID profileId rejected

- **Input:** `makeAnnotation({ profileId: 'not-a-uuid' })`
- **Expected Output:** `ReviewAnnotationSchema.parse(input)` throws `ZodError`
- **Assertions:**
  - Thrown error is an instance of `ZodError`
  - Error issues contain a path referencing `"profileId"`

---

## AC-031: ReviewAnnotation fails validation when reviewedBy is an empty string

### Edge Case — empty string rejected by min(1) constraint

- **Input:** `makeAnnotation({ reviewedBy: '' })`
- **Expected Output:** `ReviewAnnotationSchema.parse(input)` throws `ZodError`
- **Assertions:**
  - Thrown error is an instance of `ZodError`
  - Error issues contain a path referencing `"reviewedBy"`

---

## AC-032: ReviewAnnotation fails validation when tier is not in ["A", "B", "C"]

### Edge Case — unrecognized tier value rejected

- **Input:** `makeAnnotation({ tier: 'D' })`
- **Expected Output:** `ReviewAnnotationSchema.parse(input)` throws `ZodError`
- **Assertions:**
  - Thrown error is an instance of `ZodError`
  - Error issues contain a path referencing `"tier"`

---

## AC-033: ReviewAnnotation fails validation when tierReason is an empty string

### Edge Case — empty tierReason rejected by min(1) constraint

- **Input:** `makeAnnotation({ tierReason: '' })`
- **Expected Output:** `ReviewAnnotationSchema.parse(input)` throws `ZodError`
- **Assertions:**
  - Thrown error is an instance of `ZodError`
  - Error issues contain a path referencing `"tierReason"`

---

## AC-034: ReviewAnnotation parses successfully when profileAdequate is false and missingEvidenceTypes is non-empty

### Happy Path — adequacy conditional satisfied for inadequate profile

- **Input:** `makeAnnotation({ profileAdequate: false, missingEvidenceTypes: ['missing_tech_stack'] })`
- **Expected Output:** `ReviewAnnotationSchema.parse(input)` returns without throwing
- **Assertions:**
  - `result.profileAdequate === false`
  - `result.missingEvidenceTypes` contains `"missing_tech_stack"`

---

## AC-035: ReviewAnnotation fails validation when profileAdequate is false and missingEvidenceTypes is empty

### Edge Case — adequacy conditional violated: false + empty array

- **Input:** `makeAnnotation({ profileAdequate: false, missingEvidenceTypes: [] })`
- **Expected Output:** `ReviewAnnotationSchema.parse(input)` throws `ZodError`
- **Assertions:**
  - Thrown error is an instance of `ZodError`
  - Error message contains `"missingEvidenceTypes"`

---

## AC-036: ReviewAnnotation parses successfully when profileAdequate is true and missingEvidenceTypes is empty

### Happy Path — adequacy conditional satisfied for adequate profile

- **Input:** `makeAnnotation({ profileAdequate: true, missingEvidenceTypes: [] })`
- **Expected Output:** `ReviewAnnotationSchema.parse(input)` returns without throwing
- **Assertions:**
  - `result.profileAdequate === true`
  - `result.missingEvidenceTypes` has length 0

---

## AC-037: ReviewAnnotation fails validation when profileAdequate is true and missingEvidenceTypes is non-empty

### Edge Case — adequacy conditional violated: true + non-empty array

- **Input:** `makeAnnotation({ profileAdequate: true, missingEvidenceTypes: ['noise_false_positive'] })`
- **Expected Output:** `ReviewAnnotationSchema.parse(input)` throws `ZodError`
- **Assertions:**
  - Thrown error is an instance of `ZodError`
  - Error message contains `"missingEvidenceTypes"`
