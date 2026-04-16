import { z } from 'zod';
import { ValidationError } from '../sales-factory/errors';

// ── Types ────────────────────────────────────────────────────────────────────

export interface TweetPayload {
  id: string;
  text: string;
  authorId: string;
  createdAt: string; // ISO 8601
}

export interface ExtractedKeywords {
  fundingSignals: string[];
  sectorKeywords: string[];
  all: string[]; // fundingSignals ++ sectorKeywords
}

export interface ScoredTweet {
  tweetId: string;
  priorityScore: number;
  fundingSignals: string[];
  sectorKeywords: string[];
}

export interface FounderProfile {
  handle: string;
  bio: string;
  keywords: string[]; // explicit seed keywords
}

export interface LookAlikeQuery {
  keywords: string[];
  queryString: string; // ready-to-use X search query, e.g. "defi OR crypto OR founder"
}

// ── Constants ────────────────────────────────────────────────────────────────

// Phrases typical of early-stage funding announcements on X
const FUNDING_SIGNAL_PHRASES: string[] = [
  'raised seed',
  'raised $',
  'seed round',
  'thrilled to announce',
  'excited to share',
  'just closed',
  'we raised',
  'new funding',
  'proud to announce',
  'announcing our',
  'closed our round',
];

// Mirrors the allowed sectors from the Sales Factory qualification gate
const SECTOR_KEYWORDS: string[] = [
  'fintech', 'web3', 'crypto', 'defi', 'wallet', 'stablecoin',
];

// Role indicators used to identify founder-like builders in bios
const ROLE_KEYWORDS: string[] = [
  'founder', 'builder', 'cto', 'ceo', 'cofounder', 'co-founder',
  'engineer', 'developer', 'creator',
];

// Priority scoring weights
const FUNDING_SCORE = 50;
const SECTOR_SCORE = 30;
const COMBO_BONUS = 20; // both present — signals a high-value early lead

// ── Zod Schemas ───────────────────────────────────────────────────────────────

const TweetPayloadSchema = z.object({
  id: z.string().min(1, { message: 'must not be empty' }),
  text: z.string().min(1, { message: 'must not be empty' }),
  authorId: z.string().min(1, { message: 'must not be empty' }),
  createdAt: z.string().refine(
    (val) => !isNaN(Date.parse(val)),
    { message: 'must be a valid ISO 8601 date string' },
  ),
});

const FounderProfileSchema = z.object({
  handle: z.string().min(1, { message: 'must not be empty' }),
  bio: z.string(),
  keywords: z.array(z.string()),
});

// ── Validation helpers ────────────────────────────────────────────────────────

function validateTweetPayload(raw: unknown): TweetPayload {
  const result = TweetPayloadSchema.safeParse(raw);
  if (!result.success) {
    const messages = result.error.issues
      .map((issue) => {
        const path = issue.path.join('.');
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join('; ');
    throw new ValidationError(messages);
  }
  return result.data as TweetPayload;
}

function validateFounderProfile(raw: unknown): FounderProfile {
  const result = FounderProfileSchema.safeParse(raw);
  if (!result.success) {
    const messages = result.error.issues
      .map((issue) => {
        const path = issue.path.join('.');
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join('; ');
    throw new ValidationError(messages);
  }
  return result.data as FounderProfile;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function _extractKeywords(tweet: TweetPayload): ExtractedKeywords {
  const lower = tweet.text.toLowerCase();
  const fundingSignals = FUNDING_SIGNAL_PHRASES.filter((phrase) => lower.includes(phrase));
  const sectorKeywords = SECTOR_KEYWORDS.filter((kw) => lower.includes(kw));
  return { fundingSignals, sectorKeywords, all: [...fundingSignals, ...sectorKeywords] };
}

function _extractBioKeywords(bio: string): string[] {
  const lower = bio.toLowerCase();
  return [
    ...SECTOR_KEYWORDS.filter((kw) => lower.includes(kw)),
    ...ROLE_KEYWORDS.filter((kw) => lower.includes(kw)),
  ];
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Extract funding signal phrases and sector keywords from a raw tweet payload.
 * Throws ValidationError if the payload fails schema validation.
 */
export function extractKeywords(raw: unknown): ExtractedKeywords {
  return _extractKeywords(validateTweetPayload(raw));
}

/**
 * Score a tweet for lead-generation priority.
 *
 * Scoring formula:
 *   +50  any funding signal phrase detected
 *   +30  any sector keyword detected
 *   +20  combo bonus (both present — high-confidence early lead)
 *
 * Maximum score: 100. Throws ValidationError on invalid input.
 */
export function scoreTweet(raw: unknown): ScoredTweet {
  const tweet = validateTweetPayload(raw);
  const { fundingSignals, sectorKeywords } = _extractKeywords(tweet);

  let priorityScore = 0;
  if (fundingSignals.length > 0) priorityScore += FUNDING_SCORE;
  if (sectorKeywords.length > 0) priorityScore += SECTOR_SCORE;
  if (fundingSignals.length > 0 && sectorKeywords.length > 0) priorityScore += COMBO_BONUS;

  return { tweetId: tweet.id, priorityScore, fundingSignals, sectorKeywords };
}

/**
 * Build an X search query to find look-alike founders given a target profile.
 * Combines bio-extracted keywords (sector + role) with explicit seed keywords,
 * deduplicates, and returns both the keyword list and a ready-to-use query string.
 * Throws ValidationError on invalid profile input.
 */
export function buildLookAlikeQuery(raw: unknown): LookAlikeQuery {
  const profile = validateFounderProfile(raw);
  const bioKeywords = _extractBioKeywords(profile.bio);
  const explicitKeywords = profile.keywords.map((k) => k.toLowerCase());

  const keywords = [...new Set([...bioKeywords, ...explicitKeywords])];
  const queryString = keywords.join(' OR ');

  return { keywords, queryString };
}
