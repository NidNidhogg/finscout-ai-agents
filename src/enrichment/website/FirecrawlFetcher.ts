import type { PageFetcher, FetchedPage, FetchOpts, CrawlOpts } from '../EnrichmentEngine';
import { PageFetchTimeoutError, PageFetchNetworkError } from '../EnrichmentEngine';

interface FirecrawlFetcherConfig {
  apiKey: string;
  baseUrl?: string;
  pollIntervalMs?: number;
}

interface FirecrawlScrapeResponse {
  success: boolean;
  data?: {
    markdown?: string;
    metadata?: {
      title?: string;
      sourceURL?: string;
      statusCode?: number;
    };
  };
  error?: string;
}

interface FirecrawlCrawlJobResponse {
  success: boolean;
  id?: string;
  error?: string;
}

interface FirecrawlCrawlPageItem {
  markdown?: string;
  metadata?: {
    title?: string;
    sourceURL?: string;
    statusCode?: number;
  };
}

interface FirecrawlCrawlStatusResponse {
  status: 'scraping' | 'completed' | 'failed' | 'cancelled';
  data?: FirecrawlCrawlPageItem[];
  error?: string;
}

export class FirecrawlFetcher implements PageFetcher {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly pollIntervalMs: number;

  constructor(config: FirecrawlFetcherConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? 'https://api.firecrawl.dev';
    this.pollIntervalMs = config.pollIntervalMs ?? 2_000;
  }

  async fetch(url: string, _opts?: FetchOpts): Promise<FetchedPage> {
    const pages = await this.scrape(url);
    return pages[0];
  }

  async crawl(baseUrl: string, opts?: CrawlOpts): Promise<FetchedPage[]> {
    const jobId = await this.startCrawlJob(baseUrl, opts);
    return this.pollCrawlJob(baseUrl, jobId);
  }

  private async startCrawlJob(url: string, opts?: CrawlOpts): Promise<string> {
    const requestBody: Record<string, unknown> = {
      url,
      limit: opts?.maxPages ?? 5,
      scrapeOptions: { formats: ['markdown'] },
    };
    if (opts?.includePaths && opts.includePaths.length > 0) {
      requestBody['includePaths'] = opts.includePaths;
    }
    if (opts?.excludePaths && opts.excludePaths.length > 0) {
      requestBody['excludePaths'] = opts.excludePaths;
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/crawl`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new PageFetchTimeoutError(url);
      }
      throw new PageFetchNetworkError(url, err instanceof Error ? err.message : String(err));
    }

    if (!response.ok) {
      throw new PageFetchNetworkError(url, `HTTP ${response.status}`);
    }

    const jobResp: FirecrawlCrawlJobResponse = await response.json();
    if (!jobResp.id) {
      throw new PageFetchNetworkError(url, 'Firecrawl crawl job returned no ID');
    }
    return jobResp.id;
  }

  private async pollCrawlJob(baseUrl: string, jobId: string): Promise<FetchedPage[]> {
    const maxAttempts = 30;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0 && this.pollIntervalMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, this.pollIntervalMs));
      }

      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}/v1/crawl/${jobId}`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${this.apiKey}` },
        });
      } catch (err: unknown) {
        throw new PageFetchNetworkError(baseUrl, err instanceof Error ? err.message : String(err));
      }

      if (!response.ok) {
        throw new PageFetchNetworkError(baseUrl, `HTTP ${response.status}`);
      }

      const statusResp: FirecrawlCrawlStatusResponse = await response.json();

      if (statusResp.status === 'completed') {
        const fetchedAt = new Date();
        return (statusResp.data ?? []).map((item) => ({
          url: item.metadata?.sourceURL ?? baseUrl,
          markdown: item.markdown ?? '',
          title: item.metadata?.title ?? '',
          metadata: (item.metadata ?? {}) as Record<string, unknown>,
          fetchedAt,
        }));
      }

      if (statusResp.status === 'failed' || statusResp.status === 'cancelled') {
        throw new PageFetchNetworkError(
          baseUrl,
          `Crawl job ${statusResp.status}: ${statusResp.error ?? 'unknown error'}`,
        );
      }
      // status === 'scraping' — continue polling
    }

    throw new PageFetchNetworkError(baseUrl, 'Crawl job timed out after 30 polling attempts');
  }

  private async scrape(url: string): Promise<FetchedPage[]> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/scrape`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url, formats: ['markdown'] }),
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new PageFetchTimeoutError(url);
      }
      throw new PageFetchNetworkError(url, err instanceof Error ? err.message : String(err));
    }

    if (!response.ok) {
      throw new PageFetchNetworkError(url, `HTTP ${response.status}`);
    }

    const body: FirecrawlScrapeResponse = await response.json();

    const fetchedAt = new Date();
    const data = body.data ?? {};
    const metadata = data.metadata ?? {};

    return [
      {
        url: metadata.sourceURL ?? url,
        markdown: data.markdown ?? '',
        title: metadata.title ?? '',
        metadata: metadata as Record<string, unknown>,
        fetchedAt,
      },
    ];
  }
}
