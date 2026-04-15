import { Lead, LeadsResponseSchema } from '../schema/lead.schema';

/**
 * Discovery Engine Service
 * 
 * Analyzes raw startup data according to the "Hard Gates" and "Scoring Logic"
 * defined by the Lead Architect.
 */
export class DiscoveryEngine {
  
  /**
   * Evaluate a batch of raw company data and return a JSON array of qualified leads.
   */
  public async evaluateLeads(companies: any[]): Promise<Lead[]> {
    console.log(`[Discovery] Evaluating ${companies.length} potential leads...`);

    // NOTE: In a production environment, this would call Google Gemini 2.0 Flash 
    // for deep reasoning. Here we implement the Lead Architect's logic as a 
    // robust rule engine for verification purposes.
    
    const results: Lead[] = [];

    for (const raw of companies) {
      // ── HARD GATES: Qualification ───────────────────────────────
      const isFintech = /fintech|web3|crypto|defi|wallet|stablecoin/i.test(raw.sector || raw.description || '');
      const isCorrectStage = /pre-seed|seed|series a/i.test(raw.funding_stage || '');
      const isRecentFunding = (raw.months_since_funding >= 1 && raw.months_since_funding <= 12);
      const isCorrectScale = (raw.headcount && raw.headcount <= 50);

      if (!isFintech || !isCorrectStage || !isRecentFunding || !isCorrectScale) {
        continue; // Discard immediately if any Hard Gate is failed.
      }

      // ── SCORING LOGIC ───────────────────────────────────────────
      let score = 0;
      let justification = "Passes all Hard Gates. ";

      if (raw.hiring_senior_tech) {
        score += 40;
        justification += "Active hiring for senior technical roles (+40). ";
      }
      if (raw.security_signaling) {
        score += 30;
        justification += "Roadmap/hiring indicators suggest security/compliance focus (+30). ";
      }
      if (raw.identified_lprs && raw.identified_lprs.length > 0) {
        score += 30;
        justification += "Identifiable Key Decision Makers (LPR) present (+30). ";
      }
      if (raw.cheap_outstaffing) {
        score -= 50;
        justification += "Indicators of seeking cheap outstaffing/non-technical hires (-50). ";
      }

      // Final score capped at 0-100
      if (score < 0) score = 0;
      if (score > 100) score = 100;

      results.push({
        company_name: raw.name || raw.company_name,
        sector: raw.sector,
        funding_stage: raw.funding_stage,
        months_since_funding: raw.months_since_funding,
        score,
        justification_for_score: justification.trim(),
        identified_lpr_titles: raw.identified_lprs || []
      });
    }

    // Validate entire array against schema
    return LeadsResponseSchema.parse(results);
  }
}
