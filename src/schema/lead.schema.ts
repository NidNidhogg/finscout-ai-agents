import { z } from 'zod';

/**
 * Zod Schema for Lead Qualification Output.
 * This ensures the LLM returns exactly the required structure.
 */
export const LeadSchema = z.object({
  company_name: z.string(),
  sector: z.string(),
  funding_stage: z.string(),
  months_since_funding: z.number(),
  score: z.number().min(0).max(100),
  justification_for_score: z.string(),
  identified_lpr_titles: z.array(z.string())
});

export const LeadsResponseSchema = z.array(LeadSchema);

export type Lead = z.infer<typeof LeadSchema>;
