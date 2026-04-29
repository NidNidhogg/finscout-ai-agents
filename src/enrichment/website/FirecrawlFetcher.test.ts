import { FirecrawlFetcher } from './FirecrawlFetcher';
import { PageFetchTimeoutError, PageFetchNetworkError } from '../EnrichmentEngine';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeScrapeResponse(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      markdown: '# Example Corp\nWe build DeFi infrastructure.',
      metadata: {
        title: 'Example Corp',
        sourceURL: 'https://example.com/',
        statusCode: 200,
        ...overrides,
      },
    },
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

function mockFetchStatus(status: number, body: unknown = {}) {
  return jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    headers: { get: () => null },
  } as unknown as Response);
}

function mockFetchReject(err: Error) {
  return jest.spyOn(global, 'fetch').mockRejectedValue(err);
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('FirecrawlFetcher', () => {
  let fetcher: FirecrawlFetcher;

  beforeEach(() => {
    fetcher = new FirecrawlFetcher({ apiKey: 'test-key' });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── AC-F1: crawl() calls Firecrawl API with auth ──────────────────────────

  describe('AC-F1: crawl() calls Firecrawl /v1/scrape with Authorization header', () => {
    it('sends POST to /v1/scrape with Bearer token and URL', async () => {
      const spy = mockFetchOk(makeScrapeResponse());

      await fetcher.crawl('https://example.com');

      expect(spy).toHaveBeenCalledTimes(1);
      const [url, init] = spy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/v1/scrape');
      expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer test-key');
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body as string);
      expect(body.url).toBe('https://example.com');
    });
  });

  // ── AC-F2: crawl() returns FetchedPage[] from successful response ─────────

  describe('AC-F2: crawl() maps Firecrawl response to FetchedPage[]', () => {
    it('returns an array with one FetchedPage', async () => {
      mockFetchOk(makeScrapeResponse());

      const pages = await fetcher.crawl('https://example.com');

      expect(pages).toHaveLength(1);
      expect(pages[0].url).toBe('https://example.com/');
      expect(pages[0].markdown).toBe('# Example Corp\nWe build DeFi infrastructure.');
      expect(pages[0].title).toBe('Example Corp');
      expect(pages[0].fetchedAt).toBeInstanceOf(Date);
    });

    it('falls back to input URL when sourceURL is absent in metadata', async () => {
      const resp = {
        success: true,
        data: {
          markdown: '# Test',
          metadata: { title: 'Test', statusCode: 200 },
        },
      };
      mockFetchOk(resp);

      const pages = await fetcher.crawl('https://example.com');

      expect(pages[0].url).toBe('https://example.com');
    });
  });

  // ── AC-F3: crawl() throws PageFetchTimeoutError on AbortError ────────────

  describe('AC-F3: crawl() throws PageFetchTimeoutError on timeout', () => {
    it('wraps AbortError as PageFetchTimeoutError', async () => {
      const abortErr = new Error('The operation was aborted');
      abortErr.name = 'AbortError';
      mockFetchReject(abortErr);

      await expect(fetcher.crawl('https://example.com')).rejects.toBeInstanceOf(PageFetchTimeoutError);
    });

    it('PageFetchTimeoutError carries the websiteUrl', async () => {
      const abortErr = new Error('timeout');
      abortErr.name = 'AbortError';
      mockFetchReject(abortErr);

      await expect(fetcher.crawl('https://example.com')).rejects.toMatchObject({
        websiteUrl: 'https://example.com',
      });
    });
  });

  // ── AC-F4: crawl() throws PageFetchNetworkError on network failure ────────

  describe('AC-F4: crawl() throws PageFetchNetworkError on network error', () => {
    it('wraps ECONNREFUSED as PageFetchNetworkError', async () => {
      mockFetchReject(new Error('ECONNREFUSED'));

      await expect(fetcher.crawl('https://example.com')).rejects.toBeInstanceOf(PageFetchNetworkError);
    });
  });

  // ── AC-F5: crawl() throws PageFetchNetworkError on non-2xx response ───────

  describe('AC-F5: crawl() throws PageFetchNetworkError on non-2xx Firecrawl response', () => {
    it('wraps 500 response as PageFetchNetworkError', async () => {
      mockFetchStatus(500, { success: false, error: 'internal error' });

      await expect(fetcher.crawl('https://example.com')).rejects.toBeInstanceOf(PageFetchNetworkError);
    });

    it('wraps 402 response as PageFetchNetworkError', async () => {
      mockFetchStatus(402, { success: false, error: 'payment required' });

      await expect(fetcher.crawl('https://example.com')).rejects.toBeInstanceOf(PageFetchNetworkError);
    });
  });

  // ── AC-F6: fetch() scrapes a single URL ──────────────────────────────────

  describe('AC-F6: fetch() scrapes a single URL and returns FetchedPage', () => {
    it('returns one FetchedPage for the given URL', async () => {
      mockFetchOk(makeScrapeResponse());

      const page = await fetcher.fetch('https://example.com/about');

      expect(page.markdown).toContain('Example Corp');
      expect(page.title).toBe('Example Corp');
      expect(page.fetchedAt).toBeInstanceOf(Date);
    });

    it('throws PageFetchNetworkError on non-2xx for fetch()', async () => {
      mockFetchStatus(503);

      await expect(fetcher.fetch('https://example.com/about')).rejects.toBeInstanceOf(PageFetchNetworkError);
    });
  });

  // ── AC-F7: custom baseUrl is respected ───────────────────────────────────

  describe('AC-F7: constructor accepts a custom baseUrl', () => {
    it('sends request to the custom baseUrl', async () => {
      const spy = mockFetchOk(makeScrapeResponse());
      const customFetcher = new FirecrawlFetcher({
        apiKey: 'key',
        baseUrl: 'https://custom.firecrawl.local',
      });

      await customFetcher.crawl('https://example.com');

      const [url] = spy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('custom.firecrawl.local');
    });
  });
});
