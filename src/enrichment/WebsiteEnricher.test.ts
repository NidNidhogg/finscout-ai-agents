import {
  makeFetchedPage,
  createWebsiteEnricher,
  PageFetchTimeoutError,
  PageFetchNetworkError,
} from './__fixtures__/factories';
import type { PageFetcher } from './EnrichmentEngine';
import { FixturePageFetcher } from './sources/FixturePageFetcher';

describe('WebsiteEnricher — Firecrawl Boundary', () => {
  describe('AC-009: WebsiteEnricher calls PageFetcher.crawl with provided URL', () => {
    it('calls crawl on the injected PageFetcher', async () => {
      const crawlMock = jest.fn().mockResolvedValue([makeFetchedPage()]);
      const fetcher: PageFetcher = { fetch: jest.fn(), crawl: crawlMock };
      const enricher = createWebsiteEnricher({ pageFetcher: fetcher });

      await enricher.enrich('https://example.com');

      expect(crawlMock).toHaveBeenCalledWith('https://example.com', expect.anything());
    });

    it('passes a maxPages limit to control crawl depth', async () => {
      const crawlMock = jest.fn().mockResolvedValue([makeFetchedPage()]);
      const fetcher: PageFetcher = { fetch: jest.fn(), crawl: crawlMock };
      const enricher = createWebsiteEnricher({ pageFetcher: fetcher });

      await enricher.enrich('https://example.com');

      expect(crawlMock).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({ maxPages: expect.any(Number) }),
      );
    });

    it('passes excludePaths blocking PDFs and whitepaper paths on the first crawl', async () => {
      const crawlMock = jest.fn().mockResolvedValue([makeFetchedPage()]);
      const fetcher: PageFetcher = { fetch: jest.fn(), crawl: crawlMock };
      const enricher = createWebsiteEnricher({ pageFetcher: fetcher });

      await enricher.enrich('https://example.com');

      expect(crawlMock).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({
          excludePaths: expect.arrayContaining([
            expect.stringContaining('.pdf'),
            expect.stringContaining('whitepaper'),
          ]),
        }),
      );
    });

    it('passes includePaths prioritising doc/sdk/developer/api/wiki on the first crawl', async () => {
      const crawlMock = jest.fn().mockResolvedValue([makeFetchedPage(), makeFetchedPage()]);
      const fetcher: PageFetcher = { fetch: jest.fn(), crawl: crawlMock };
      const enricher = createWebsiteEnricher({ pageFetcher: fetcher });

      await enricher.enrich('https://example.com');

      expect(crawlMock).toHaveBeenNthCalledWith(
        1,
        'https://example.com',
        expect.objectContaining({
          includePaths: expect.arrayContaining(['doc', 'sdk', 'developer', 'api', 'wiki']),
        }),
      );
    });
  });

  describe('AC-009b: two-phase crawl — fallback when no doc paths exist', () => {
    it('retries without includePaths when the first crawl returns only one page', async () => {
      const rootOnly = [makeFetchedPage({ url: 'https://example.com/' })];
      const fullPages = [
        makeFetchedPage({ url: 'https://example.com/' }),
        makeFetchedPage({ url: 'https://example.com/blog' }),
        makeFetchedPage({ url: 'https://example.com/about' }),
      ];
      const crawlMock = jest.fn()
        .mockResolvedValueOnce(rootOnly)
        .mockResolvedValueOnce(fullPages);
      const fetcher: PageFetcher = { fetch: jest.fn(), crawl: crawlMock };
      const enricher = createWebsiteEnricher({ pageFetcher: fetcher });

      const data = await enricher.enrich('https://example.com');

      expect(crawlMock).toHaveBeenCalledTimes(2);
      expect(data.pagesFetched).toHaveLength(3);
      const [, fallbackOpts] = crawlMock.mock.calls[1] as [string, Record<string, unknown>];
      expect(fallbackOpts).not.toHaveProperty('includePaths');
      expect(fallbackOpts).toHaveProperty('excludePaths');
    });

    it('does not retry when the first crawl returns more than one page', async () => {
      const multiPage = [
        makeFetchedPage({ url: 'https://example.com/docs' }),
        makeFetchedPage({ url: 'https://example.com/sdk' }),
      ];
      const crawlMock = jest.fn().mockResolvedValue(multiPage);
      const fetcher: PageFetcher = { fetch: jest.fn(), crawl: crawlMock };
      const enricher = createWebsiteEnricher({ pageFetcher: fetcher });

      await enricher.enrich('https://example.com');

      expect(crawlMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('AC-010: pagesFetched contains one entry per page returned by crawl', () => {
    it('maps crawl output to pagesFetched array', async () => {
      const pages = [
        makeFetchedPage({ url: 'https://example.com/' }),
        makeFetchedPage({ url: 'https://example.com/about' }),
      ];
      const fetcher: PageFetcher = { fetch: jest.fn(), crawl: jest.fn().mockResolvedValue(pages) };
      const enricher = createWebsiteEnricher({ pageFetcher: fetcher });

      const data = await enricher.enrich('https://example.com');

      expect(data.pagesFetched).toHaveLength(2);
      expect(data.pagesFetched[0].url).toBe('https://example.com/');
      expect(data.pagesFetched[1].url).toBe('https://example.com/about');
    });
  });

  describe('AC-011: websiteMarkdown is keyed by page URL', () => {
    it('populates websiteMarkdown correctly', async () => {
      const page = makeFetchedPage({ url: 'https://example.com/', markdown: '# Hello' });
      const fetcher: PageFetcher = { fetch: jest.fn(), crawl: jest.fn().mockResolvedValue([page]) };
      const enricher = createWebsiteEnricher({ pageFetcher: fetcher });

      const data = await enricher.enrich('https://example.com');

      expect(data.websiteMarkdown['https://example.com/']).toBe('# Hello');
    });
  });

  describe('AC-012: pages with empty markdown are not filtered out', () => {
    it('includes all pages regardless of markdown content', async () => {
      const pages = [
        makeFetchedPage({ url: 'https://example.com/about', markdown: '' }),
        makeFetchedPage({ url: 'https://example.com/careers', markdown: '' }),
      ];
      const fetcher: PageFetcher = { fetch: jest.fn(), crawl: jest.fn().mockResolvedValue(pages) };
      const enricher = createWebsiteEnricher({ pageFetcher: fetcher });

      const data = await enricher.enrich('https://example.com');

      expect(data.pagesFetched).toHaveLength(2);
    });
  });

  describe('AC-013: enrich throws PageFetchTimeoutError on timeout', () => {
    it('wraps timeout error in PageFetchTimeoutError', async () => {
      const timeoutErr = new Error('timeout');
      timeoutErr.name = 'TimeoutError';
      const fetcher: PageFetcher = {
        fetch: jest.fn(),
        crawl: jest.fn().mockRejectedValue(timeoutErr),
      };
      const enricher = createWebsiteEnricher({ pageFetcher: fetcher });

      await expect(enricher.enrich('https://example.com')).rejects.toBeInstanceOf(PageFetchTimeoutError);
    });
  });

  describe('AC-014: enrich throws PageFetchNetworkError on non-timeout error', () => {
    it('wraps network error in PageFetchNetworkError', async () => {
      const netErr = new Error('ECONNREFUSED');
      const fetcher: PageFetcher = {
        fetch: jest.fn(),
        crawl: jest.fn().mockRejectedValue(netErr),
      };
      const enricher = createWebsiteEnricher({ pageFetcher: fetcher });

      await expect(enricher.enrich('https://example.com')).rejects.toBeInstanceOf(PageFetchNetworkError);
    });
  });

  describe('AC-015: FixturePageFetcher returns pages or empty array', () => {
    it('returns an array (with or without fixtures) for example.com', async () => {
      const fetcher = new FixturePageFetcher();
      const pages = await fetcher.crawl('https://example.com');
      expect(Array.isArray(pages)).toBe(true);
    });

    it('returns empty array for a hostname with no fixtures', async () => {
      const fetcher = new FixturePageFetcher();
      const pages = await fetcher.crawl('https://this-hostname-has-no-fixtures.example.com');
      expect(pages).toHaveLength(0);
    });
  });

  describe('AC-016: WebsiteEnricher with controlled pages returns deterministic results', () => {
    it('extracts multisig from markdown and preserves raw content', async () => {
      const controlledPages = [
        makeFetchedPage({
          url: 'https://example.com/about',
          markdown: '## About\nWe build HSM key management and multisig wallets.',
        }),
      ];
      const fetcher: PageFetcher = {
        fetch: jest.fn(),
        crawl: jest.fn().mockResolvedValue(controlledPages),
      };
      const enricher = createWebsiteEnricher({ pageFetcher: fetcher });

      const data = await enricher.enrich('https://example.com');

      expect(data.extractedProduct.architectureTerms).toEqual(
        expect.arrayContaining(['multisig']),
      );
      expect(data.websiteMarkdown['https://example.com/about']).toContain('HSM');
    });
  });
});
