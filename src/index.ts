import express, { Request, Response } from 'express';
import axios from 'axios';
import { DiscoveryEngine } from './services/discoveryEngine';
import { ResearcherEngine } from './services/researcherEngine';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

const discoveryEngine = new DiscoveryEngine();
const researcherEngine = new ResearcherEngine();
const PORT = process.env.PORT || 3001;

// ── GET /v1/health (Health Check) ────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'OK', service: 'finscout-ai-agents' }));

// ── POST /v1/discovery/evaluate (Discovery Endpoint) ──────────────
app.post('/v1/discovery/evaluate', async (req: Request, res: Response) => {
  try {
    const { companies } = req.body;
    if (!companies || !Array.isArray(companies)) {
      return res.status(400).json({ error: 'Missing or invalid "companies" payload.' });
    }

    const qualifiedLeads = await discoveryEngine.evaluateLeads(companies);
    res.json(qualifiedLeads);
  } catch (error) {
    console.error('[Discovery] Failure:', error);
    res.status(500).json({ error: 'Lead evaluation failed.', details: String(error) });
  }
});

// ── POST /v1/research/synthesize (Researcher Endpoint) ─────────────
// Synthesize a lead into strategic context for the Ghostwriter.
app.post('/v1/research/synthesize', async (req: Request, res: Response) => {
  try {
    const lead = req.body;
    if (!lead || !lead.company_name || !lead.sector) {
      return res.status(400).json({ error: 'Missing lead context (company_name, sector).' });
    }

    const contextBundle = await researcherEngine.synthesizeResearch(lead);
    res.json(contextBundle);
  } catch (error) {
    console.error('[Researcher] Failure:', error);
    res.status(500).json({ error: 'Research synthesis failed.', details: String(error) });
  }
});

// ── STARTUP PULSE CHECK ───────────────────────────────────────────
const API_BASE = process.env.FINSCOUT_API_URL || 'http://finscout-api:3000';

async function performPulseCheck() {
  console.log(`[Discovery] Booting. Pinging Portal API at ${API_BASE}/v1/integrity/status...`);
  try {
    const response = await axios.get(`${API_BASE}/v1/integrity/status?uid=1`);
    if (response.data.report.status === 'SECURE') {
      console.log('✅ PULSE CHECK SUCCESS: Ecosystem is secure and reachable.');
    } else {
      console.error('⚠️ PULSE CHECK WARNING: Ecosystem portal reports non-secure status.');
    }
  } catch (error) {
    console.error('❌ PULSE CHECK FAILED: Cannot reach the Portal API. Service will start but ecosystem connectivity is broken.');
  }
}

app.listen(PORT, async () => {
  console.log(`[Discovery] AI Agents Service is live on port ${PORT}`);
  await performPulseCheck();
});
