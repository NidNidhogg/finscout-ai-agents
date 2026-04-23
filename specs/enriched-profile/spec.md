# SPEC: EnrichedProfile
<!-- spec-version: 1.0 -->
<!-- status: forward -->
<!-- signed-by: -->
<!-- date: 2026-04-22 -->
<!-- superseded-by: -->

## 1. Intent

`EnrichedProfile` is the central data contract produced by Module A (EnrichmentEngine) and consumed by Module B (ScoringAgent) in the FinScout discovery pipeline. It represents a fully enriched company profile — combining signals from the X API and a website crawl — ready for human review and tier assignment. It carries no tier, no score, and no verdict; those are added by the consumer layers.

`ReviewAnnotation` is the companion contract written by the analyst during the review queue workflow. It attaches an adequacy judgment, missing-evidence tags, a tier decision, and a Crunchbase cross-reference to an existing `EnrichedProfile`, linked by `profileId`.

Both schemas are defined using Zod v4 and serve as the authoritative runtime contracts. Unlike operation-based specs (which document function signatures with TypeScript interfaces), this is a data contract spec where the schema *is* the specification. The Zod code in Section 3 is not pseudocode — it is the normative interface definition.

## 2. Functional Contract

| Schema | Producer | Consumer | Idempotent | Side Effects |
|--------|----------|----------|------------|--------------|
| `EnrichedProfile` | EnrichmentEngine (Module A) | ScoringAgent (Module B), ReviewQueue | Yes | None — pure data shape |
| `ReviewAnnotation` | Analyst (ReviewQueue UI/CLI) | ScoringAgent pipeline, reporting | Yes | None — pure data shape |

## 3. Interface Contract

> All schemas use Zod v4. Dates are represented as ISO 8601 strings (`z.string().datetime()`), not `z.date()` objects, for JSON-serializability and SQLite compatibility. URL fields use `z.string().url()`. UUIDs use `z.string().uuid()`.

### 3.1 EnrichedProfileSchema

```typescript
import { z } from 'zod';

export const CompetencyCellSchema = z.enum([
  "DeFi & Yield",
  "Trading",
  "Infrastructure",
  "Security",
  "Payment Rails",
]);

export const FundingStageSchema = z.enum([
  "pre-seed",
  "seed",
  "series-a",
  "series-b",
  "series-c",
  "growth",
  "other",
]);

export const EnrichedProfileSchema = z.object({
  id: z.string().uuid(),
  enrichedAt: z.string().datetime(),
  schemaVersion: z.literal("1.0.0"),
  sources: z.object({
    xApi: z.object({
      lastFetched: z.string().datetime(),
      tweetsConsidered: z.number().int().nonnegative(),
      founderHandle: z.string().optional(),
    }).optional(),
    websiteCrawl: z.object({
      lastFetched: z.string().datetime(),
      pagesCrawled: z.array(z.string().url()),
      fetcher: z.string().min(1), // "firecrawl" in Phase 1
    }).optional(),
  }),
  company: z.object({
    name: z.string().min(1),
    normalizedName: z.string().min(1),
    websiteUrl: z.string().url(),
    xHandle: z.string().optional(),
    linkedinUrl: z.string().url().optional(),
    country: z.string().optional(),
  }),
  funding: z.object({
    claimed: z.object({
      amountUSD: z.number().positive().optional(),
      stage: FundingStageSchema.optional(),
      claimedAt: z.string().datetime().optional(),
      announcementUrl: z.string().url().optional(),
      rawText: z.string().optional(),
      templateMatched: z.array(z.string()).optional(),
    }),
    confirmed: z.object({
      amountUSD: z.number().positive().optional(),
      stage: FundingStageSchema.optional(),
      closedAt: z.string().datetime().optional(),
      investors: z.array(z.string()).optional(),
      leadTimeDays: z.number().int().nonnegative().optional(),
      foundInCrunchbase: z.boolean(),
    }).optional(),
  }),
  product: z.object({
    description: z.string().optional(),
    selfClaimedCategory: z.string().optional(),
    stackMentions: z.array(z.string()),
    architectureTerms: z.array(z.string()),
    antiSignalTerms: z.array(z.string()),
    competencyCellMatches: z.array(z.object({
      cell: CompetencyCellSchema,
      matchedSignals: z.array(z.string()),
      matchedCoreSignals: z.array(z.string()),
      score: z.number().min(0).max(1),
    })),
    evidence: z.array(z.object({
      page: z.string().url(),
      snippet: z.string(),
      relevance: z.enum(["high", "medium", "low"]),
      relatedCells: z.array(CompetencyCellSchema).optional(),
    })),
  }),
  team: z.object({
    estimatedHeadcount: z.number().int().positive().optional(),
    headcountSource: z.enum(["about_page", "careers_count", "unknown"]).optional(),
    founders: z.array(z.object({
      name: z.string().optional(),
      role: z.string().optional(),
      xHandle: z.string().optional(),
      linkedinUrl: z.string().url().optional(),
      bioSnippet: z.string().optional(),
      isFoundingEngineer: z.boolean().optional(),
    })),
    openRoles: z.array(z.object({
      title: z.string().min(1),
      stackHints: z.array(z.string()),
      seniority: z.enum(["junior", "mid", "senior", "lead"]).optional(),
    })).optional(),
  }),
  rawContent: z.object({
    websiteMarkdown: z.record(z.string(), z.string()),
    sourceTweets: z.array(z.object({
      id: z.string().min(1),
      text: z.string().min(1),
      postedAt: z.string().datetime(),
      authorHandle: z.string().min(1),
      authorBio: z.string().optional(),
    })).optional(),
  }),
});

export type EnrichedProfile = z.infer<typeof EnrichedProfileSchema>;
export type CompetencyCell = z.infer<typeof CompetencyCellSchema>;
export type FundingStage = z.infer<typeof FundingStageSchema>;
```

### 3.2 ReviewAnnotationSchema

```typescript
export const MissingEvidenceTypeSchema = z.enum([
  "missing_tech_stack",
  "missing_traction_signal",
  "missing_founder_context",
  "missing_architecture_signal",
  "noise_false_positive",
]);

export const DowngradeReasonSchema = z.enum([
  "competency_mismatch",
  "wrong_vertical",
  "business_risk_override",
  "stage_too_late",
  "stage_too_early",
  "acquired_or_state_backed",
]);

export const ReviewAnnotationSchema = z.object({
  profileId: z.string().uuid(),
  reviewedAt: z.string().datetime(),
  reviewedBy: z.string().min(1),
  profileAdequate: z.boolean(),
  missingEvidenceTypes: z.array(MissingEvidenceTypeSchema),
  reviewerNote: z.string().optional(),
  tier: z.enum(["A", "B", "C"]),
  tierReason: z.string().min(1),
  downgradeReasons: z.array(DowngradeReasonSchema).optional(),
  crunchbaseCheck: z.object({
    checked: z.boolean(),
    foundInCrunchbase: z.boolean().optional(),
    actualAmountUSD: z.number().positive().optional(),
    actualStage: FundingStageSchema.optional(),
    actualDate: z.string().datetime().optional(),
  }),
}).refine(
  (data) => {
    if (!data.profileAdequate) {
      return data.missingEvidenceTypes.length >= 1;
    }
    return data.missingEvidenceTypes.length === 0;
  },
  {
    message: "profileAdequate=false requires at least one entry in missingEvidenceTypes; profileAdequate=true requires missingEvidenceTypes to be empty",
    path: ["missingEvidenceTypes"],
  },
);

export type ReviewAnnotation = z.infer<typeof ReviewAnnotationSchema>;
export type MissingEvidenceType = z.infer<typeof MissingEvidenceTypeSchema>;
export type DowngradeReason = z.infer<typeof DowngradeReasonSchema>;
```

## 4. Boundary Contract

### 4.1 EnrichedProfile

- Does NOT: compute tier, assign scores, make routing decisions, or trigger side effects.
- Assumes: all fields arrive as JSON from the EnrichmentEngine; Zod `.parse()` runs at the pipeline boundary before passing to ScoringAgent.
- Depends on: `zod` for schema validation.
- `sources` is always present (required object); both `xApi` and `websiteCrawl` sub-objects are optional to model partial enrichment states. An `EnrichedProfile` with `sources: {}` is valid.
- `funding.claimed` is always present (required); `funding.confirmed` is optional and filled only after Crunchbase cross-reference.
- URL fields (`websiteUrl`, `linkedinUrl`, `announcementUrl`, `pagesCrawled`, `evidence[].page`) are validated as URLs at schema parse time.
- `amountUSD` (in both `claimed` and `confirmed`) is validated as `.positive()` — zero-dollar funding is not a valid funding event.

### 4.2 ReviewAnnotation

- Does NOT: modify the `EnrichedProfile`; the annotation is a separate document linked by `profileId`.
- Depends on: `zod`, `FundingStageSchema` (imported from the EnrichedProfile schema file).
- The adequacy conditional invariant is enforced as a single Zod `refine` on the root schema:
  - `profileAdequate=false` requires `missingEvidenceTypes.length >= 1`
  - `profileAdequate=true` requires `missingEvidenceTypes.length === 0`
- `crunchbaseCheck.checked=false` is valid with all optional sub-fields absent.
- `downgradeReasons` is optional; presence without a downgrade is not constrained by the schema.
- If input fails Zod validation: a `ZodError` is thrown; callers are responsible for mapping to their preferred error type.

## 5. Acceptance Criteria

### EnrichedProfile — id, enrichedAt, schemaVersion

- AC-001: A valid UUID string in `id` must parse successfully.
- AC-002: An `id` value that is not a valid UUID format must fail validation.
- AC-003: A valid ISO 8601 datetime string in `enrichedAt` must parse successfully.
- AC-004: An `enrichedAt` value that is not a valid ISO 8601 datetime string must fail validation.
- AC-005: `schemaVersion` equal to `"1.0.0"` must parse successfully.
- AC-006: `schemaVersion` equal to any value other than `"1.0.0"` (e.g., `"2.0.0"` or `"1.0"`) must fail validation.

### EnrichedProfile — sources

- AC-007: An `EnrichedProfile` with `sources: {}` (both sub-objects absent) must parse successfully.
- AC-008: An `EnrichedProfile` with a fully populated `sources.xApi` object must parse successfully.
- AC-009: `sources.xApi.tweetsConsidered` set to a negative integer must fail validation.
- AC-010: An `EnrichedProfile` with a fully populated `sources.websiteCrawl` object must parse successfully.
- AC-011: A `sources.websiteCrawl.pagesCrawled` entry that is not a valid URL must fail validation.

### EnrichedProfile — company

- AC-012: `company.name` set to an empty string must fail validation.
- AC-013: `company.websiteUrl` set to a non-URL string must fail validation.
- AC-014: `company.linkedinUrl`, when present, set to a non-URL string must fail validation.

### EnrichedProfile — funding

- AC-015: `funding.claimed` with all optional fields omitted must parse successfully.
- AC-016: `funding.claimed.amountUSD`, when present, set to zero or a negative number must fail validation.
- AC-017: `funding.claimed.stage`, when present, set to a value not in the `FundingStage` enum must fail validation.
- AC-018: `funding.confirmed`, when present with `foundInCrunchbase` as a boolean, must parse successfully.
- AC-019: `funding.confirmed.leadTimeDays`, when present, set to a negative integer must fail validation.

### EnrichedProfile — product

- AC-020: A `product.competencyCellMatches` entry with a `cell` value not in the `CompetencyCell` enum must fail validation.
- AC-021: A `product.competencyCellMatches` entry with a `score` value outside the `[0, 1]` range must fail validation.
- AC-022: A `product.evidence` entry with a `relevance` value not in `["high", "medium", "low"]` must fail validation.
- AC-023: A `product.evidence` entry with a `page` value that is not a valid URL must fail validation.

### EnrichedProfile — team

- AC-024: `team.founders` as an empty array must parse successfully.
- AC-025: A `team.openRoles` entry with an empty string `title` must fail validation.
- AC-026: A `team.openRoles` entry with a `seniority` value not in `["junior", "mid", "senior", "lead"]` must fail validation.

### EnrichedProfile — rawContent

- AC-027: `rawContent.websiteMarkdown` as an empty record (`{}`) must parse successfully.
- AC-028: A `rawContent.sourceTweets` entry with an empty string `id` must fail validation.
- AC-029: A `rawContent.sourceTweets` entry with a `postedAt` value that is not a valid ISO 8601 datetime string must fail validation.

### ReviewAnnotation — core fields

- AC-030: `profileId` set to a string that is not a valid UUID must fail validation.
- AC-031: `reviewedBy` set to an empty string must fail validation.
- AC-032: `tier` set to a value not in `["A", "B", "C"]` must fail validation.
- AC-033: `tierReason` set to an empty string must fail validation.

### ReviewAnnotation — adequacy conditional invariant

- AC-034: A `ReviewAnnotation` with `profileAdequate=false` and a non-empty `missingEvidenceTypes` array must parse successfully.
- AC-035: A `ReviewAnnotation` with `profileAdequate=false` and an empty `missingEvidenceTypes` array must fail validation with an error message referencing `"missingEvidenceTypes"`.
- AC-036: A `ReviewAnnotation` with `profileAdequate=true` and an empty `missingEvidenceTypes` array must parse successfully.
- AC-037: A `ReviewAnnotation` with `profileAdequate=true` and a non-empty `missingEvidenceTypes` array must fail validation with an error message referencing `"missingEvidenceTypes"`.

## 6. MVA Constraints

### 6.1 Security Boundaries

- All producers of `EnrichedProfile` and `ReviewAnnotation` data must call `EnrichedProfileSchema.parse()` or `ReviewAnnotationSchema.parse()` at the pipeline boundary before passing data downstream.
- No raw type assertions (`as EnrichedProfile`) are permitted at system boundaries; Zod parse is the sole validation path.
- URL fields are validated by Zod's `z.string().url()` at parse time; no further sanitization is required within the schema layer.

### 6.2 Resource Ceilings

- Both schemas are pure data shapes: no network calls, no file I/O, no async operations.
- Schema validation is synchronous and runs at O(n) relative to the number of fields.

### 6.3 Failure Modes & Degradation

- Any Zod parse failure throws a `ZodError`; callers are responsible for mapping to their preferred error type (e.g., `ValidationError` from `../sales-factory/errors`).
- No partial results: parse either returns the fully-typed value or throws; no partial success.
- A `schemaVersion` mismatch causes parse failure at the boundary; downstream code never sees an unversioned profile.

### 6.4 Rollback & Kill Switch

- Both schemas are pure data definitions with no persistent state; rollback = deploy the previous schema version.
- `EnrichedProfile.schemaVersion` is a `z.literal("1.0.0")` field; a version increment requires a new literal value and a new spec version.
- No feature flags required for v1.0.

### 6.5 Observability

- No internal logging in v1.0; observability is the responsibility of the calling layer.

## 7. Test Scaffold Reference

See: specs/enriched-profile/test-scaffold.md
