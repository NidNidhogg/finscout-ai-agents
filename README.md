# The Sales Factory — Autonomous Discovery & Research

> **Classification:** Internal — Engineering  
> **AESTHETIC:** Resilience by Design  
> **Domain:** Lead Qualification, MVA Mapping, Strategic Research

The `finscout-ai-agents` microservice serves as the "Sales Factory" for the FinScout outsourced MVA studio. It automates the discovery of high-value startup leads and synthesizes strategic context for executive-level outreach.

---

## 🏗️ The Multi-Agent Pipeline

The Factory implements two primary specialized agents:

### 1. The Discovery Engine
Qualified leads are filtered through a series of **Hard Gates** to ensure high-fidelity targeting:
- **Sector**: Fintech, Web3, Crypto (specifically DeFi, Tokenization, Wallets, Stablecoins).
- **Funding Stage**: Pre-Seed, Seed, or Series A ONLY.
- **Funding Recency**: Closed within 1 to 12 months.
- **Scale**: Headcount $\leq$ 50 employees.

#### Scoring Logic
Leads that pass the gates are scored (out of 100):
- **$+40$**: Active hiring for senior technical roles (Node.js, TypeScript, Rust, Smart Contracts).
- **$+30$**: Identifiable Key Decision Maker (LPR) present (Founder, CTO, CEO).
- **$+$30**: High-security roadmap or compliance signals.
- **$-50$**: Indicators of seeking cheap outstaffing or purely non-technical hires.

### 2. The Researcher Agent
Synthesizes discovery data into **Strategic Context**:
- **MVA Mapping**: Maps lead sub-sectors to the most relevant MVA block (e.g., DeFi/Wallets $\to$ Security Layer [HSM/Multisig]).
- **The Economic Wedge**: Formulates the "MVA vs MVP" argument ($3.5x$ cheaper refactoring cost).
- **Live Proof Integration**: Connects to the **Portal API** to fetch real-time "Block Height" and "SECURE" status, providing technical legitimacy to the sales argument.

---

## 🛡️ Microservice Endpoints

### `POST /v1/discovery/evaluate`
Injest raw company data and returns qualified/scored leads.

### `POST /v1/research/synthesize`
Transforms a qualified lead into a strategic context bundle for the Ghostwriter.

---

## 🚀 Operations

**Start the Sales Factory:**
```bash
docker compose up -d finscout-discovery-engine
```

**Verify Technical Pulse Check:**
The service pings `http://finscout-api:3000/v1/integrity/status` on startup to confirm technical authority. Check logs:
```bash
docker logs finscout-discovery-engine
```
