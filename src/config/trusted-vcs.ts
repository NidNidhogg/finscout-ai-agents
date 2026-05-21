/**
 * Canonical lowercase list of trusted institutional VCs used to gate the X-Radar VC Bypass.
 * Matching is done against author X handle and bio (case-insensitive, separators stripped).
 * "led by" / "backed by" text matching also uses this list.
 *
 * Tiers:
 *   Tier 1 & Blue Chips
 *   Tier 1.5 & Premier Crypto-Native
 *   Active Tier 2 & High-Conviction Funds
 *   Ecosystem & Protocol-Focused Funds
 */
export const TRUSTED_CRYPTO_VCS: string[] = [
  // ── Tier 1 & Blue Chips ──────────────────────────────────────────────────────
  'a16z',
  'paradigm',
  'pantera',
  'polychain',
  'dragonfly',
  'binance labs',
  'coinbase ventures',
  'multicoin',
  'blockchain capital',
  'sequoia',
  'lightspeed',

  // ── Tier 1.5 & Premier Crypto-Native ─────────────────────────────────────────
  'framework',
  'delphi digital',
  'variant',
  'electric capital',
  'spartan group',
  'hashed',
  'jump crypto',
  'galaxy digital',
  'coinfund',
  '1kx',
  'robot ventures',
  'placeholder',
  'fabric ventures',
  'mechanism capital',
  'archetype',
  'animoca',

  // ── Active Tier 2 & High-Conviction Funds ────────────────────────────────────
  'maven 11',
  'outlier ventures',
  'shima capital',
  'dao5',
  'arca',
  'amber group',
  'fenbushi',
  'kenetic',
  'bessemer',
  'rockaway',
  'gumi cryptos',
  'kr1',
  'iosg',
  'sevenx',
  'snz',
  'hashkey',
  'big brain holdings',
  'ngc',
  'ld capital',
  'cms holdings',
  'primitive',
  'collab+currency',
  'collab currency',
  'dweb3',
  'vandal',
  'spark capital',

  // ── Ecosystem & Protocol-Focused Funds ───────────────────────────────────────
  'solana ventures',
  'ton ventures',
  'mirana',
  'mantle',
  'arbitrum',
  'optimism',
  'avax',
  'avalanche',
  'polygon ventures',
  'starkware',
  'near foundation',
  'sui',
  'mysten labs',
  'aptos',
  'tron',
  'scroll',
  'base ecosystem',
];
