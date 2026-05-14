import type { CompetencyCell } from '../../schema/enrichedProfile';
import type { ResolvedFingerprint, Signal } from '../../fingerprint/schemas';
import {
  matchesTemplates as _matchesTemplates,
  detectAntiVocab as _detectAntiVocab,
  matchPrimarySignals as _matchPrimarySignals,
  isBelowFundingThreshold as _isBelowFundingThreshold,
  extractFundingAmountUSD as _extractFundingAmountUSD,
} from './filters';

// ── Public types ──────────────────────────────────────────────────────────────

export interface Tweet {
  id: string;
  text: string;
  authorHandle: string;
  authorBio?: string;
  authorProfileUrl?: string;
  postedAt: string;
}

export interface ResolvedCompany {
  websiteUrl: string | null;
  name?: string;
  xHandle?: string;
}

export interface CompanyCandidate {
  tweetId: string;
  tweetText: string;
  authorHandle: string;
  authorBio?: string;
  postedAt: string;
  matchedTemplates: string[];
  matchedPrimarySignals: string[];
  matchedCells: CompetencyCell[];
  resolvedCompany: ResolvedCompany;
  discoveredAt: string;
}

export type FilterRejectionReason =
  | 'no_template_match'
  | 'anti_vocab_detected'
  | 'insufficient_density'
  | 'low_funding'
  | 'company_unresolvable';

// ── XApiClient ────────────────────────────────────────────────────────────────

export interface SearchParams {
  query: string;
  maxResults?: number;
  sinceId?: string;
}

export interface XApiClient {
  searchRecentTweets(params: SearchParams): Promise<Tweet[]>;
}

// ── CompanyResolver ───────────────────────────────────────────────────────────

export interface CompanyResolver {
  resolve(authorHandle: string, tweetText: string, profileUrl?: string): Promise<ResolvedCompany | null>;
}

// ── XSignalSource ─────────────────────────────────────────────────────────────

export interface XSignalSourceConfig {
  searchQuery: string;
  maxResults?: number;
  densityThreshold?: number;
}

export interface XSignalSourceDeps {
  xClient: XApiClient;
  resolver: CompanyResolver;
  fingerprints: ResolvedFingerprint[];
  config: XSignalSourceConfig;
}

export interface PollOpts {
  sinceId?: string;
}

export interface XSignalSource {
  pollOnce(opts?: PollOpts): Promise<CompanyCandidate[]>;
}

// ── Error classes ─────────────────────────────────────────────────────────────

export class XSignalSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XSignalSourceError';
  }
}

export class XRateLimitError extends XSignalSourceError {
  constructor(public readonly retryAfterMs?: number) {
    super('X API rate limit exceeded');
    this.name = 'XRateLimitError';
  }
}

export class XAuthError extends XSignalSourceError {
  constructor() {
    super('X API authentication failed');
    this.name = 'XAuthError';
  }
}

export class XNetworkError extends XSignalSourceError {
  constructor(public readonly cause?: unknown) {
    super('X API network error');
    this.name = 'XNetworkError';
  }
}

export class XResponseError extends XSignalSourceError {
  constructor(
    public readonly statusCode: number,
    public readonly body?: unknown,
  ) {
    super(`X API returned error status: ${statusCode}`);
    this.name = 'XResponseError';
  }
}

// ── Re-exported pure functions ────────────────────────────────────────────────

export const matchesTemplates = _matchesTemplates;
export const detectAntiVocab = _detectAntiVocab;
export const matchPrimarySignals = _matchPrimarySignals;
export const isBelowFundingThreshold = _isBelowFundingThreshold;
export const extractFundingAmountUSD = _extractFundingAmountUSD;

export const FUNDING_THRESHOLD_USD = 1_000_000;

// ── Factory ───────────────────────────────────────────────────────────────────

function deduplicateSignals(signals: Signal[]): Signal[] {
  const map = new Map<string, Signal>();
  for (const s of signals) map.set(s.term, s);
  return [...map.values()];
}

export function createXSignalSource(deps: XSignalSourceDeps): XSignalSource {
  const { xClient, resolver, fingerprints, config } = deps;
  const densityThreshold = config.densityThreshold ?? 1;

  return {
    async pollOnce(opts?: PollOpts): Promise<CompanyCandidate[]> {
      const tweets = await xClient.searchRecentTweets({
        query: config.searchQuery,
        maxResults: config.maxResults,
        sinceId: opts?.sinceId,
      });

      // Deduplicate by tweet.id
      const seen = new Set<string>();
      const uniqueTweets = tweets.filter((t) => {
        if (seen.has(t.id)) return false;
        seen.add(t.id);
        return true;
      });

      // Vocabulary unions across all fingerprints
      const allAntiSignals = deduplicateSignals(fingerprints.flatMap((fp) => fp.antiSignals));
      const allPrimarySignals = deduplicateSignals(fingerprints.flatMap((fp) => fp.primarySignals));

      // DEBUG ─────────────────────────────────────────────────────────────
      console.debug(`[XSignalSource] raw tweets received: ${uniqueTweets.length}`);
      console.debug(`[XSignalSource] primary vocab (${allPrimarySignals.length} terms): ${allPrimarySignals.map((s) => s.term).join(', ')}`);
      console.debug(`[XSignalSource] anti vocab    (${allAntiSignals.length} terms): ${allAntiSignals.map((s) => s.term).join(', ')}`);
      console.debug(`[XSignalSource] density threshold: ${densityThreshold}`);
      // ────────────────────────────────────────────────────────────────────

      const candidates: CompanyCandidate[] = [];

      for (const tweet of uniqueTweets) {
        const handle = tweet.authorHandle;
        const preview = tweet.text.slice(0, 80).replace(/\n/g, ' ');

        // Filter 1: template match
        const matchedTemplates = matchesTemplates(tweet.text);
        if (matchedTemplates.length === 0) {
          console.debug(`[XSignalSource] DISCARD f1:no_template   ${handle} — "${preview}"`);
          continue;
        }

        // Filter 2: anti-vocab (runs before density — invariant)
        const antiVocab = detectAntiVocab(tweet.text, tweet.authorBio, allAntiSignals);
        if (antiVocab !== null) {
          console.debug(`[XSignalSource] DISCARD f2:anti_vocab    ${handle} — matched anti-term: "${antiVocab}" | "${preview}"`);
          continue;
        }

        // Filter 3: primary signal density
        const matchedPrimarySignals = _matchPrimarySignals(
          tweet.text,
          tweet.authorBio,
          allPrimarySignals,
        );
        if (matchedPrimarySignals.length < densityThreshold) {
          console.debug(`[XSignalSource] DISCARD f3:low_density   ${handle} — matched [${matchedPrimarySignals.join(', ') || 'none'}] (need ${densityThreshold}) | "${preview}"`);
          continue;
        }

        // Filter 5: funding amount threshold — discard only when an explicit sub-$1M amount is detected
        if (_isBelowFundingThreshold(tweet.text, FUNDING_THRESHOLD_USD)) {
          const amount = _extractFundingAmountUSD(tweet.text);
          console.debug(`[XSignalSource] DISCARD f5:low_funding   ${handle} — $${amount?.toLocaleString()} < $1M threshold | "${preview}"`);
          continue;
        }

        // Filter 4: company resolver — tweet text URL first, profile URL as fallback
        const resolved = await resolver.resolve(tweet.authorHandle, tweet.text, tweet.authorProfileUrl);
        const resolvedCompany: ResolvedCompany = resolved ?? { websiteUrl: null, xHandle: tweet.authorHandle };

        if (resolved === null) {
          console.debug(`[XSignalSource] PASS ✓ (lite)          ${handle} — no URL, X data only | signals:[${matchedPrimarySignals.join(', ')}] | "${preview}"`);
        } else {
          console.debug(`[XSignalSource] PASS    ✓              ${handle} → ${resolved.websiteUrl} signals:[${matchedPrimarySignals.join(', ')}]`);
        }

        // matchedCells: per-fingerprint density check
        const matchedCells: CompetencyCell[] = [];
        for (const fp of fingerprints) {
          const fpMatched = _matchPrimarySignals(tweet.text, tweet.authorBio, fp.primarySignals);
          if (fpMatched.length >= densityThreshold) {
            matchedCells.push(fp.cell);
          }
        }

        candidates.push({
          tweetId: tweet.id,
          tweetText: tweet.text,
          authorHandle: tweet.authorHandle,
          authorBio: tweet.authorBio,
          postedAt: tweet.postedAt,
          matchedTemplates,
          matchedPrimarySignals,
          matchedCells,
          resolvedCompany: resolvedCompany,
          discoveredAt: new Date().toISOString(),
        });
      }

      return candidates;
    },
  };
}
