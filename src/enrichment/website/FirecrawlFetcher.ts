import type { PageFetcher, FetchedPage, FetchOpts, CrawlOpts } from '../EnrichmentEngine';
import { PageFetchTimeoutError, PageFetchNetworkError } from '../EnrichmentEngine';

interface FirecrawlFetcherConfig {
  apiKey: string;
  baseUrl?: string;
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

export class FirecrawlFetcher implements PageFetcher {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: FirecrawlFetcherConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? 'https://api.firecrawl.dev';
  }

  async fetch(url: string, _opts?: FetchOpts): Promise<FetchedPage> {
    const pages = await this.scrape(url);
    return pages[0];
  }

  async crawl(baseUrl: string, _opts?: CrawlOpts): Promise<FetchedPage[]> {
    return this.scrape(baseUrl);
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
