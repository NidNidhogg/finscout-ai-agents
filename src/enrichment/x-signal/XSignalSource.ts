import type { CompetencyCell } from '../../schema/enrichedProfile';
import type { ResolvedFingerprint, Signal } from '../../fingerprint/schemas';
import {
  matchesTemplates as _matchesTemplates,
  detectAntiVocab as _detectAntiVocab,
  matchPrimarySignals as _matchPrimarySignals,
} from './filters';

// ── Public types ──────────────────────────────────────────────────────────────

export interface Tweet {
  id: string;
  text: string;
  authorHandle: string;
  authorBio?: string;
  postedAt: string;
}

export interface ResolvedCompany {
  websiteUrl: string;
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
  resolve(authorHandle: string, tweetText: string): Promise<ResolvedCompany | null>;
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

      const candidates: CompanyCandidate[] = [];

      for (const tweet of uniqueTweets) {
        // Filter 1: template match
        const matchedTemplates = matchesTemplates(tweet.text);
        if (matchedTemplates.length === 0) continue;

        // Filter 2: anti-vocab (runs before density — invariant)
        const antiVocab = detectAntiVocab(tweet.text, tweet.authorBio, allAntiSignals);
        if (antiVocab !== null) continue;

        // Filter 3: primary signal density
        const matchedPrimarySignals = _matchPrimarySignals(
          tweet.text,
          tweet.authorBio,
          allPrimarySignals,
        );
        if (matchedPrimarySignals.length < densityThreshold) continue;

        // Filter 4: company resolver
        const resolved = await resolver.resolve(tweet.authorHandle, tweet.text);
        if (resolved === null) continue;

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
          resolvedCompany: resolved,
          discoveredAt: new Date().toISOString(),
        });
      }

      return candidates;
    },
  };
}
