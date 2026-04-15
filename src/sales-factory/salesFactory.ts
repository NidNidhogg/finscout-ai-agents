import { z } from 'zod';
import { ClockError, ValidationError } from './errors';

// ── Types ────────────────────────────────────────────────────────────────────

export interface Signal {
  type: 'HIRING_TECH' | 'LPR' | 'SECURITY' | 'OUTSTAFFING';
}

export interface LeadInput {
  companyId: string;
  sector: string;
  stage: string;
  lastFundedAt: string;
  headcount: number;
  signals: Signal[];
}

export type QualifiedLead = LeadInput;

export interface QualificationResult {
  companyId: string;
  status: 'QUALIFIED' | 'DISQUALIFIED';
  failedGate?: 'SECTOR' | 'STAGE' | 'FUNDING_RECENCY' | 'HEADCOUNT';
  lead?: QualifiedLead;
}

export interface ScoredLead {
  companyId: string;
  sector: string;
  score: number;
  mvaRecommendations: string[];
}

// ── Constants ────────────────────────────────────────────────────────────────

const ALLOWED_SECTORS = new Set(['fintech', 'web3', 'crypto', 'defi', 'wallet', 'stablecoin']);
const ALLOWED_STAGES = new Set(['pre-seed', 'seed', 'series a']);

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MIN_FUNDING_DAYS = 30;
const MAX_FUNDING_DAYS = 365;

const SIGNAL_WEIGHTS: Record<Signal['type'], number> = {
  HIRING_TECH: 40,
  LPR: 30,
  SECURITY: 30,
  OUTSTAFFING: -50,
};

const SECURITY_LAYER = 'Security Layer (HSM/Multisig)';
const SECURITY_SECTORS = new Set(['defi', 'wallet']);

// ── Zod Schema ───────────────────────────────────────────────────────────────

const SignalSchema = z.object({
  type: z.enum(['HIRING_TECH', 'LPR', 'SECURITY', 'OUTSTAFFING']),
});

const LeadInputSchema = z.object({
  companyId: z.string(),
  sector: z.string(),
  stage: z.string(),
  lastFundedAt: z.string().refine(
    (val) => !isNaN(Date.parse(val)),
    { message: 'must be a valid ISO 8601 date string' },
  ),
  headcount: z.number().int().min(1),
  signals: z.array(SignalSchema),
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function validateLeadInput(raw: unknown): LeadInput {
  const result = LeadInputSchema.safeParse(raw);
  if (!result.success) {
    const messages = result.error.issues
      .map((issue) => {
        const path = issue.path.join('.');
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join('; ');
    throw new ValidationError(messages);
  }
  return result.data as LeadInput;
}

function logQualification(result: QualificationResult, startMs: number): void {
  console.log(JSON.stringify({
    companyId: result.companyId,
    status: result.status,
    failedGate: result.failedGate,
    durationMs: Date.now() - startMs,
  }));
}

// ── AC-001..AC-005: qualifyLead ───────────────────────────────────────────────

export function qualifyLead(raw: unknown): QualificationResult {
  const start = Date.now();
  const input = validateLeadInput(raw);

  // Gate 1 — Sector (AC-001)
  if (!ALLOWED_SECTORS.has(input.sector.toLowerCase())) {
    const result: QualificationResult = { companyId: input.companyId, status: 'DISQUALIFIED', failedGate: 'SECTOR' };
    logQualification(result, start);
    return result;
  }

  // Gate 2 — Stage (AC-002)
  if (!ALLOWED_STAGES.has(input.stage.toLowerCase())) {
    const result: QualificationResult = { companyId: input.companyId, status: 'DISQUALIFIED', failedGate: 'STAGE' };
    logQualification(result, start);
    return result;
  }

  // Gate 3 — Funding Recency (AC-003)
  const now = Date.now();
  if (isNaN(now)) {
    throw new ClockError('System clock is unavailable');
  }
  const diffDays = (now - Date.parse(input.lastFundedAt)) / MS_PER_DAY;
  if (diffDays < MIN_FUNDING_DAYS || diffDays > MAX_FUNDING_DAYS) {
    const result: QualificationResult = { companyId: input.companyId, status: 'DISQUALIFIED', failedGate: 'FUNDING_RECENCY' };
    logQualification(result, start);
    return result;
  }

  // Gate 4 — Headcount (AC-004)
  if (input.headcount > 50) {
    const result: QualificationResult = { companyId: input.companyId, status: 'DISQUALIFIED', failedGate: 'HEADCOUNT' };
    logQualification(result, start);
    return result;
  }

  // AC-005 — All gates passed
  const result: QualificationResult = { companyId: input.companyId, status: 'QUALIFIED', lead: input };
  logQualification(result, start);
  return result;
}

// ── AC-006..AC-011: scoreLead ────────────────────────────────────────────────

export function scoreLead(lead: QualifiedLead): ScoredLead {
  const start = Date.now();
  const signalsApplied: Signal['type'][] = [];

  const score = lead.signals.reduce((acc, signal) => {
    signalsApplied.push(signal.type);
    return acc + SIGNAL_WEIGHTS[signal.type];
  }, 0);

  console.log(JSON.stringify({ companyId: lead.companyId, score, signalsApplied, durationMs: Date.now() - start }));

  return { companyId: lead.companyId, sector: lead.sector, score, mvaRecommendations: [] };
}

// ── AC-012..AC-013: mapMVA ────────────────────────────────────────────────────

export function mapMVA(scored: ScoredLead): ScoredLead {
  const recommendations = [...scored.mvaRecommendations];
  if (SECURITY_SECTORS.has(scored.sector.toLowerCase())) {
    recommendations.push(SECURITY_LAYER);
  }
  return { ...scored, mvaRecommendations: recommendations };
}
