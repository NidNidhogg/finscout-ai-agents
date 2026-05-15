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

function makeCrawlJobResponse(id = 'job-123') {
  return { success: true, id };
}

function makeCrawlDataItem(overrides: {
  markdown?: string;
  title?: string;
  sourceURL?: string;
} = {}) {
  return {
    markdown: overrides.markdown ?? '# Example Corp\nWe build DeFi infrastructure.',
    metadata: {
      title: overrides.title ?? 'Example Corp',
      sourceURL: overrides.sourceURL ?? 'https://example.com/',
      statusCode: 200,
    },
  };
}

function makeCrawlCompletedResponse(items = [makeCrawlDataItem()]) {
  return { status: 'completed' as const, data: items };
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

function mockCrawlSuccess(items = [makeCrawlDataItem()]) {
  return jest.spyOn(global, 'fetch')
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makeCrawlJobResponse()),
      headers: { get: () => null },
    } as unknown as Response)
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makeCrawlCompletedResponse(items)),
      headers: { get: () => null },
    } as unknown as Response);
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('FirecrawlFetcher', () => {
  let fetcher: FirecrawlFetcher;

  beforeEach(() => {
    fetcher = new FirecrawlFetcher({ apiKey: 'test-key', pollIntervalMs: 0 });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── AC-F1: crawl() POSTs to /v1/crawl with auth ──────────────────────────

  describe('AC-F1: crawl() POSTs to /v1/crawl with Authorization header', () => {
    it('sends POST to /v1/crawl with Bearer token, URL, and limit', async () => {
      const spy = mockCrawlSuccess();

      await fetcher.crawl('https://example.com');

      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining('/v1/crawl'),
        expect.objectContaining({ method: 'POST' }),
      );
      const [url, init] = spy.mock.calls[0] as [string, RequestInit];
      expect(url).not.toMatch(/\/v1\/crawl\/.+/); // not the polling endpoint
      expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer test-key');
      const body = JSON.parse(init.body as string);
      expect(body.url).toBe('https://example.com');
      expect(body.limit).toBeGreaterThan(0);
    });

    it('sends includePaths in the request body when provided via opts', async () => {
      const spy = mockCrawlSuccess();

      await fetcher.crawl('https://example.com', { includePaths: ['/docs', '/about'] });

      const [, init] = spy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.includePaths).toEqual(['/docs', '/about']);
    });

    it('sends excludePaths in the request body when provided via opts', async () => {
      const spy = mockCrawlSuccess();

      await fetcher.crawl('https://example.com', { excludePaths: ['.pdf', 'whitepaper'] });

      const [, init] = spy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.excludePaths).toEqual(['.pdf', 'whitepaper']);
    });
  });

  // ── AC-F2: crawl() maps async crawl response to FetchedPage[] ────────────

  describe('AC-F2: crawl() maps Firecrawl crawl response to FetchedPage[]', () => {
    it('returns an array with one FetchedPage from crawl data', async () => {
      mockCrawlSuccess();

      const pages = await fetcher.crawl('https://example.com');

      expect(pages).toHaveLength(1);
      expect(pages[0].url).toBe('https://example.com/');
      expect(pages[0].markdown).toBe('# Example Corp\nWe build DeFi infrastructure.');
      expect(pages[0].title).toBe('Example Corp');
      expect(pages[0].fetchedAt).toBeInstanceOf(Date);
    });

    it('falls back to input URL when sourceURL is absent in crawl data', async () => {
      jest.spyOn(global, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve(makeCrawlJobResponse()),
          headers: { get: () => null },
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            status: 'completed',
            data: [{ markdown: '# Test', metadata: { title: 'Test', statusCode: 200 } }],
          }),
          headers: { get: () => null },
        } as unknown as Response);

      const pages = await fetcher.crawl('https://example.com');

      expect(pages[0].url).toBe('https://example.com');
    });
  });

  // ── AC-F3: crawl() throws PageFetchTimeoutError on AbortError ────────────

  describe('AC-F3: crawl() throws PageFetchTimeoutError on timeout', () => {
    it('wraps AbortError on crawl POST as PageFetchTimeoutError', async () => {
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
    it('wraps ECONNREFUSED on crawl POST as PageFetchNetworkError', async () => {
      mockFetchReject(new Error('ECONNREFUSED'));

      await expect(fetcher.crawl('https://example.com')).rejects.toBeInstanceOf(PageFetchNetworkError);
    });
  });

  // ── AC-F5: crawl() throws PageFetchNetworkError on non-2xx response ───────

  describe('AC-F5: crawl() throws PageFetchNetworkError on non-2xx Firecrawl response', () => {
    it('wraps 500 on crawl POST as PageFetchNetworkError', async () => {
      mockFetchStatus(500, { success: false, error: 'internal error' });

      await expect(fetcher.crawl('https://example.com')).rejects.toBeInstanceOf(PageFetchNetworkError);
    });

    it('wraps 402 on crawl POST as PageFetchNetworkError', async () => {
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
    it('sends crawl request to the custom baseUrl', async () => {
      const spy = jest.spyOn(global, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve(makeCrawlJobResponse()),
          headers: { get: () => null },
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve(makeCrawlCompletedResponse()),
          headers: { get: () => null },
        } as unknown as Response);

      const customFetcher = new FirecrawlFetcher({
        apiKey: 'key',
        baseUrl: 'https://custom.firecrawl.local',
        pollIntervalMs: 0,
      });

      await customFetcher.crawl('https://example.com');

      const [url] = spy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('custom.firecrawl.local');
    });
  });

  // ── AC-F8: crawl() polls /v1/crawl/{id} after receiving job ID ───────────

  describe('AC-F8: crawl() polls /v1/crawl/{id} for job status', () => {
    it('makes a GET request to /v1/crawl/{jobId} to check status', async () => {
      const spy = mockCrawlSuccess();

      await fetcher.crawl('https://example.com');

      expect(spy).toHaveBeenCalledTimes(2);
      const [pollUrl, pollInit] = spy.mock.calls[1] as [string, RequestInit];
      expect(pollUrl).toContain('/v1/crawl/job-123');
      expect((pollInit as RequestInit & { method: string }).method).toBe('GET');
    });

    it('continues polling when status is "scraping" then resolves on "completed"', async () => {
      jest.spyOn(global, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve(makeCrawlJobResponse()),
          headers: { get: () => null },
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ status: 'scraping' }),
          headers: { get: () => null },
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve(makeCrawlCompletedResponse()),
          headers: { get: () => null },
        } as unknown as Response);

      const pages = await fetcher.crawl('https://example.com');

      expect(pages).toHaveLength(1);
    });
  });

  // ── AC-F9: crawl() throws on failed job status ────────────────────────────

  describe('AC-F9: crawl() throws PageFetchNetworkError when crawl job fails', () => {
    it('throws PageFetchNetworkError when job status is "failed"', async () => {
      jest.spyOn(global, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve(makeCrawlJobResponse()),
          headers: { get: () => null },
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ status: 'failed', error: 'site unreachable' }),
          headers: { get: () => null },
        } as unknown as Response);

      await expect(fetcher.crawl('https://example.com')).rejects.toBeInstanceOf(PageFetchNetworkError);
    });
  });

  // ── AC-F10: crawl() returns multiple pages from a deep crawl ─────────────

  describe('AC-F10: crawl() returns multiple FetchedPage entries for multi-page crawl', () => {
    it('maps all pages in crawl data to FetchedPage[]', async () => {
      const items = [
        makeCrawlDataItem({ sourceURL: 'https://example.com/', title: 'Home' }),
        makeCrawlDataItem({ sourceURL: 'https://example.com/docs', title: 'Docs', markdown: '## Smart contract architecture' }),
        makeCrawlDataItem({ sourceURL: 'https://example.com/about', title: 'About' }),
      ];
      mockCrawlSuccess(items);

      const pages = await fetcher.crawl('https://example.com');

      expect(pages).toHaveLength(3);
      expect(pages[0].url).toBe('https://example.com/');
      expect(pages[1].url).toBe('https://example.com/docs');
      expect(pages[1].markdown).toContain('Smart contract');
      expect(pages[2].url).toBe('https://example.com/about');
    });
  });
});
