// model-pricing.ts — USD-per-1M-token pricing for cost telemetry.
// Update when switching DEFAULT_MODEL or when provider pricing changes.
// Prices are estimates for reporting, not billing truth.

export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  'gemini-2.0-flash': { inputPer1M: 0.1, outputPer1M: 0.4 },
};

const FALLBACK: ModelPricing = { inputPer1M: 0.1, outputPer1M: 0.4 };

export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = MODEL_PRICING[model] ?? FALLBACK;
  return (inputTokens / 1_000_000) * pricing.inputPer1M +
    (outputTokens / 1_000_000) * pricing.outputPer1M;
}
