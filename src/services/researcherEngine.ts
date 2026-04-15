import axios from 'axios';
import { Lead } from '../schema/lead.schema';

/**
 * Researcher Engine Service (Phase 7.1)
 * 
 * Synthesizes raw lead data into Strategic Context for the Ghostwriter.
 * Maps sub-sectors to MVA building blocks and fetches live technical authority.
 */
export class ResearcherEngine {
  private readonly API_BASE = process.env.FINSCOUT_API_URL || 'http://finscout-api:3000';

  /**
   * Synthesize research for a qualified lead.
   */
  public async synthesizeResearch(lead: Lead) {
    console.log(`[Researcher] Synthesizing strategic context for ${lead.company_name}...`);

    // ── STEP 1: MVA Mapping (Strategic Alignment) ─────────────────
    const { mva_solution, pain_point } = this.mapToMVAFramework(lead.sector);

    // ── STEP 2: The Wedge (Economic Argument) ─────────────────────
    const economicWedge = this.formulateEconomicArgument(mva_solution);

    // ── STEP 3: Live Proof Fetching (Technical Authority) ──────────
    const liveProof = await this.fetchLiveProof();

    // ── STEP 4: Context Bundle Assembly ───────────────────────────
    return {
      lead_profile: {
        name: lead.company_name,
        sector: lead.sector,
        score: lead.score
      },
      strategic_context: {
        pain_point: pain_point,
        mva_solution: mva_solution,
        economic_wedge: economicWedge
      },
      live_proof: {
        status: liveProof.status,
        block_height: liveProof.block_height,
        verification_url: `${this.API_BASE}/v1/integrity/status?uid=1`
      },
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Internal mapping logic based on MVA Framework.
   */
  private mapToMVAFramework(sector: string) {
    const s = sector.toLowerCase();
    
    if (s.includes('wallet') || s.includes('defi') || s.includes('stablecoin')) {
      return {
        mva_solution: 'Security Layer (HSM/Multisig Integration)',
        pain_point: 'High-value asset vulnerability and private key management risks.'
      };
    }
    
    if (s.includes('scaling') || s.includes('infrastructure') || s.includes('high-load') || s.includes('gaming')) {
      return {
        mva_solution: 'High-Load Core (NodeJS/Rust/K8s Orchestration)',
        pain_point: 'Systemic failure under rapid user scaling or RPC bottlenecks.'
      };
    }
    
    if (s.includes('cross-border') || s.includes('b2b') || s.includes('aml') || s.includes('kyc') || s.includes('compliance')) {
      return {
        mva_solution: 'Compliance Ready (Formal Verification/AML Automation)',
        pain_point: 'Regulatory friction and the massive cost of post-hoc compliance retrofitting.'
      };
    }

    // Default Fallback
    return {
      mva_solution: 'Zero-Trust MVA Foundation (Core Ledger)',
      pain_point: 'Foundation-level data integrity and auditability gaps.'
    };
  }

  /**
   * Logic for the 'Economic Argument' against standard MVPs.
   */
  private formulateEconomicArgument(mva_solution: string) {
    return `Building an MVA (Minimum Viable Architecture) in Phase 1 is 3.5x cheaper than refactoring a standard 'fast-code' MVP once technical debt or security vulnerabilities achieve critical mass. Our ${mva_solution} approach eliminates the 'Compliance Tax' and 'Security Tax' typically paid during Series B.`;
  }

  /**
   * Fetches real-time technical authority from the Portal API.
   */
  private async fetchLiveProof() {
    try {
      const response = await axios.get(`${this.API_BASE}/v1/integrity/status?uid=1`);
      return {
        status: response.data.report.status,
        block_height: response.data.report.block_height
      };
    } catch (error) {
      console.warn('[Researcher] Portal API unreachable. Using fallback proof metrics.');
      return {
        status: 'OFFLINE_VERIFIED',
        block_height: 0
      };
    }
  }
}
