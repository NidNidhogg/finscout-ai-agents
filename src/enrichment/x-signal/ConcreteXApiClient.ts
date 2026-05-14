import type { XApiClient, SearchParams, Tweet } from './XSignalSource';
import { XRateLimitError, XAuthError, XNetworkError, XResponseError } from './XSignalSource';

interface ConcreteXApiClientConfig {
  bearerToken: string;
  baseUrl?: string;
}

interface XApiTweet {
  id: string;
  text: string;
  author_id: string;
  created_at: string;
}

interface XApiUrlEntity {
  url: string;
  expanded_url: string;
  display_url: string;
  start: number;
  end: number;
}

interface XApiUser {
  id: string;
  username: string;
  description?: string;
  entities?: {
    url?: { urls?: XApiUrlEntity[] };
    description?: { urls?: XApiUrlEntity[] };
  };
}

interface XApiResponse {
  data?: XApiTweet[];
  includes?: {
    users?: XApiUser[];
  };
  errors?: Array<{ message: string }>;
}

export class ConcreteXApiClient implements XApiClient {
  private readonly bearerToken: string;
  private readonly baseUrl: string;

  constructor(config: ConcreteXApiClientConfig) {
    this.bearerToken = config.bearerToken;
    this.baseUrl = config.baseUrl ?? 'https://api.twitter.com';
  }

  async searchRecentTweets(params: SearchParams): Promise<Tweet[]> {
    const qs = new URLSearchParams({
      query: params.query,
      'tweet.fields': 'created_at,author_id',
      expansions: 'author_id',
      'user.fields': 'username,description,url,entities,public_metrics',
    });

    if (params.maxResults !== undefined) {
      qs.set('max_results', String(params.maxResults));
    }
    if (params.sinceId !== undefined) {
      qs.set('since_id', params.sinceId);
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/2/tweets/search/recent?${qs.toString()}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.bearerToken}`,
        },
      });
    } catch (err: unknown) {
      throw new XNetworkError(err instanceof Error ? err.message : String(err));
    }

    if (!response.ok) {
      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        const retryAfterMs = retryAfter !== null ? parseFloat(retryAfter) * 1000 : undefined;
        throw new XRateLimitError(retryAfterMs);
      }
      if (response.status === 401 || response.status === 403) {
        throw new XAuthError();
      }
      const body = await response.json() as XApiResponse;
      throw new XResponseError(response.status, body.errors?.[0]?.message ?? `HTTP ${response.status}`);
    }

    const body: XApiResponse = await response.json();
    const tweets = body.data ?? [];
    const users = body.includes?.users ?? [];

    return tweets.map((tweet) => {
      const user = users.find((u) => u.id === tweet.author_id);
      const authorProfileUrl = user?.entities?.url?.urls?.[0]?.expanded_url;
      return {
        id: tweet.id,
        text: tweet.text,
        authorHandle: user ? `@${user.username}` : '@unknown',
        authorBio: user?.description,
        authorProfileUrl: authorProfileUrl || undefined,
        postedAt: tweet.created_at,
      };
    });
  }
}
