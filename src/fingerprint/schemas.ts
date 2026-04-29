import { z } from 'zod';
import { CompetencyCellSchema } from '../schema/enrichedProfile';

export { CompetencyCellSchema };

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

export const ResolvedFingerprintSchema = z.object({
  cell: CompetencyCellSchema,
  resolvedAt: z.string().datetime(),
  primarySignals: z.array(SignalSchema),
  antiSignals: z.array(SignalSchema),
});

export type Signal = z.infer<typeof SignalSchema>;
export type CoreFingerprintFile = z.infer<typeof CoreFingerprintFileSchema>;
export type CellFingerprintFile = z.infer<typeof CellFingerprintFileSchema>;
export type ResolvedFingerprint = z.infer<typeof ResolvedFingerprintSchema>;
