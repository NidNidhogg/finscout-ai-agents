import { z } from 'zod';

export const CompetencyCellSchema = z.enum([
  "DeFi & Yield",
  "Trading",
  "Infrastructure",
  "Security",
  "Payment Rails",
]);

export const FundingStageSchema = z.enum([
  "pre_seed",
  "seed",
  "series_a",
  "series_b",
  "series_c",
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
