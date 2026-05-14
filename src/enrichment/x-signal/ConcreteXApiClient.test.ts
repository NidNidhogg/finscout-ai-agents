import { ConcreteXApiClient } from './ConcreteXApiClient';
import { XRateLimitError, XAuthError, XNetworkError, XResponseError } from './XSignalSource';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeXApiResponse(overrides: Record<string, unknown> = {}) {
  return {
    data: [
      {
        id: '1234567890',
        text: 'we raised $5M seed round for our DeFi protocol multisig',
        author_id: '987654321',
        created_at: '2026-04-25T00:00:00.000Z',
      },
    ],
    includes: {
      users: [
        {
          id: '987654321',
          username: 'acmedefi',
          description: 'Building DeFi infrastructure | founder @acmedefi',
          entities: {
            url: {
              urls: [
                {
                  url: 'https://t.co/abc123',
                  expanded_url: 'https://acmedefi.io',
                  display_url: 'acmedefi.io',
                  start: 0,
                  end: 23,
                },
              ],
            },
          },
        },
      ],
    },
    ...overrides,
  };
}

function mockFetchOk(body: unknown, headers?: Record<string, string>) {
  return jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    headers: { get: (name: string) => headers?.[name] ?? null },
  } as unknown as Response);
}

function mockFetchStatus(status: number, body: unknown = {}, headers?: Record<string, string>) {
  return jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve(body),
    headers: { get: (name: string) => headers?.[name] ?? null },
  } as unknown as Response);
}

function mockFetchReject(err: Error) {
  return jest.spyOn(global, 'fetch').mockRejectedValue(err);
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('ConcreteXApiClient', () => {
  let client: ConcreteXApiClient;

  beforeEach(() => {
    client = new ConcreteXApiClient({ bearerToken: 'test-bearer-token' });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── AC-X1: calls X API with correct Authorization header ─────────────────

  describe('AC-X1: searchRecentTweets() calls X API with Bearer token', () => {
    it('sends GET to /2/tweets/search/recent with Authorization header', async () => {
      const spy = mockFetchOk(makeXApiResponse());

      await client.searchRecentTweets({ query: 'seed round defi' });

      expect(spy).toHaveBeenCalledTimes(1);
      const [url, init] = spy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/2/tweets/search/recent');
      expect(url).toContain('seed+round+defi');
      expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer test-bearer-token');
    });
  });

  // ── AC-X2: maps API response to Tweet[] ──────────────────────────────────

  describe('AC-X2: searchRecentTweets() returns Tweet[] from response', () => {
    it('maps X API data to Tweet objects', async () => {
      mockFetchOk(makeXApiResponse());

      const tweets = await client.searchRecentTweets({ query: 'seed round' });

      expect(tweets).toHaveLength(1);
      expect(tweets[0].id).toBe('1234567890');
      expect(tweets[0].text).toContain('multisig');
      expect(tweets[0].authorHandle).toBe('@acmedefi');
      expect(tweets[0].authorBio).toBe('Building DeFi infrastructure | founder @acmedefi');
      expect(tweets[0].postedAt).toBe('2026-04-25T00:00:00.000Z');
    });

    it('returns empty array when X API returns no data', async () => {
      mockFetchOk({ data: [], includes: { users: [] } });

      const tweets = await client.searchRecentTweets({ query: 'rare query' });

      expect(tweets).toHaveLength(0);
    });

    it('handles missing includes gracefully', async () => {
      mockFetchOk({ data: [{ id: '1', text: 'hello', author_id: '999', created_at: '2026-04-01T00:00:00.000Z' }] });

      const tweets = await client.searchRecentTweets({ query: 'hello' });

      expect(tweets).toHaveLength(1);
      expect(tweets[0].authorHandle).toBe('@unknown');
    });
  });

  // ── AC-X3: 429 → XRateLimitError with retryAfterMs ───────────────────────

  describe('AC-X3: 429 response throws XRateLimitError', () => {
    it('throws XRateLimitError on 429', async () => {
      mockFetchStatus(429, {}, { 'retry-after': '30' });

      await expect(
        client.searchRecentTweets({ query: 'test' }),
      ).rejects.toBeInstanceOf(XRateLimitError);
    });

    it('parses Retry-After header into retryAfterMs (seconds → ms)', async () => {
      mockFetchStatus(429, {}, { 'retry-after': '60' });

      let err: XRateLimitError | undefined;
      try {
        await client.searchRecentTweets({ query: 'test' });
      } catch (e) {
        err = e as XRateLimitError;
      }

      expect(err?.retryAfterMs).toBe(60000);
    });

    it('retryAfterMs is undefined when Retry-After header is absent', async () => {
      mockFetchStatus(429, {});

      let err: XRateLimitError | undefined;
      try {
        await client.searchRecentTweets({ query: 'test' });
      } catch (e) {
        err = e as XRateLimitError;
      }

      expect(err?.retryAfterMs).toBeUndefined();
    });
  });

  // ── AC-X4: 401/403 → XAuthError ──────────────────────────────────────────

  describe('AC-X4: 401/403 response throws XAuthError', () => {
    it('throws XAuthError on 401', async () => {
      mockFetchStatus(401);

      await expect(
        client.searchRecentTweets({ query: 'test' }),
      ).rejects.toBeInstanceOf(XAuthError);
    });

    it('throws XAuthError on 403', async () => {
      mockFetchStatus(403);

      await expect(
        client.searchRecentTweets({ query: 'test' }),
      ).rejects.toBeInstanceOf(XAuthError);
    });
  });

  // ── AC-X5: network error → XNetworkError ─────────────────────────────────

  describe('AC-X5: fetch() rejection throws XNetworkError', () => {
    it('wraps TypeError as XNetworkError', async () => {
      mockFetchReject(new TypeError('Failed to fetch'));

      await expect(
        client.searchRecentTweets({ query: 'test' }),
      ).rejects.toBeInstanceOf(XNetworkError);
    });
  });

  // ── AC-X6: sinceId is passed to the API ──────────────────────────────────

  describe('AC-X6: sinceId parameter is forwarded to X API', () => {
    it('includes since_id in the query string when provided', async () => {
      const spy = mockFetchOk(makeXApiResponse());

      await client.searchRecentTweets({ query: 'seed round', sinceId: '1111111111' });

      const [url] = spy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('since_id=1111111111');
    });

    it('omits since_id when not provided', async () => {
      const spy = mockFetchOk(makeXApiResponse());

      await client.searchRecentTweets({ query: 'seed round' });

      const [url] = spy.mock.calls[0] as [string, RequestInit];
      expect(url).not.toContain('since_id');
    });
  });

  // ── AC-X7: maxResults is passed to the API ───────────────────────────────

  describe('AC-X7: maxResults parameter is forwarded to X API', () => {
    it('includes max_results in the query string when provided', async () => {
      const spy = mockFetchOk(makeXApiResponse());

      await client.searchRecentTweets({ query: 'seed round', maxResults: 25 });

      const [url] = spy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('max_results=25');
    });
  });

  // ── AC-X8: other non-2xx → XResponseError ────────────────────────────────

  describe('AC-X8: other non-2xx response throws XResponseError', () => {
    it('throws XResponseError on 500', async () => {
      mockFetchStatus(500, { errors: [{ message: 'internal' }] });

      await expect(
        client.searchRecentTweets({ query: 'test' }),
      ).rejects.toBeInstanceOf(XResponseError);
    });
  });

  // ── AC-X9: extracts authorProfileUrl from user entities ──────────────────

  describe('AC-X9: searchRecentTweets() extracts authorProfileUrl from user entities', () => {
    it('populates authorProfileUrl from user.entities.url.urls[0].expanded_url', async () => {
      mockFetchOk(makeXApiResponse());

      const tweets = await client.searchRecentTweets({ query: 'seed round' });

      expect(tweets[0].authorProfileUrl).toBe('https://acmedefi.io');
    });

    it('authorProfileUrl is undefined when user has no entities', async () => {
      mockFetchOk({
        data: [{ id: '1', text: 'seed round defi', author_id: '999', created_at: '2026-01-01T00:00:00.000Z' }],
        includes: { users: [{ id: '999', username: 'nourl', description: 'no url here' }] },
      });

      const tweets = await client.searchRecentTweets({ query: 'seed round' });

      expect(tweets[0].authorProfileUrl).toBeUndefined();
    });

    it('authorProfileUrl is undefined when entities.url has no urls array', async () => {
      mockFetchOk({
        data: [{ id: '1', text: 'seed round defi', author_id: '999', created_at: '2026-01-01T00:00:00.000Z' }],
        includes: { users: [{ id: '999', username: 'nourl', entities: { url: { urls: [] } } }] },
      });

      const tweets = await client.searchRecentTweets({ query: 'seed round' });

      expect(tweets[0].authorProfileUrl).toBeUndefined();
    });

    it('user.fields request param includes url, entities, and public_metrics', async () => {
      const spy = mockFetchOk(makeXApiResponse());

      await client.searchRecentTweets({ query: 'seed round' });

      const [rawUrl] = spy.mock.calls[0] as [string, RequestInit];
      const url = decodeURIComponent(rawUrl);
      expect(url).toContain('url');
      expect(url).toContain('entities');
      expect(url).toContain('public_metrics');
    });
  });
});
