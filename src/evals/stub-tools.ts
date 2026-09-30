/**
 * stub-tools.ts — deterministic tool implementations for the eval contour.
 *
 * Serves the golden fixture's own rawContent (websiteMarkdown + sourceTweets)
 * back through the PageFetcher / XApiClient interfaces the harness injects.
 * The LLM and harness logic stay fully live; only external I/O is stubbed,
 * so eval results don't drift with the real web.
 */

import type { EnrichedProfile } from '../schema/enrichedProfile';
import type { PageFetcher, FetchedPage, FetchOpts, CrawlOpts } from '../enrichment/EnrichmentEngine';
import type { XApiClient, Tweet, SearchParams } from '../enrichment/x-signal/XSignalSource';

export class FixturePageFetcher implements PageFetcher {
  constructor(private readonly profile: EnrichedProfile) {}

  async fetch(url: string, _opts?: FetchOpts): Promise<FetchedPage> {
    const markdown = this.lookup(url);
    if (!markdown) {
      throw new Error(`fixture: no page for ${url}`);
    }
    return { url, markdown, title: '', metadata: {}, fetchedAt: new Date() };
  }

  async crawl(baseUrl: string, _opts?: CrawlOpts): Promise<FetchedPage[]> {
    const pages = this.profile.rawContent.websiteMarkdown;
    return Object.entries(pages)
      .filter(([url]) => url.startsWith(baseUrl) || baseUrl.startsWith(new URL(url).origin))
      .map(([url, markdown]) => ({
        url, markdown, title: '', metadata: {}, fetchedAt: new Date(),
      }));
  }

  private lookup(url: string): string | undefined {
    const pages = this.profile.rawContent.websiteMarkdown;
    return pages[url] ?? pages[url.replace(/\/$/, '')] ?? pages[url + '/'];
  }
}

export class FixtureXApiClient implements XApiClient {
  constructor(private readonly profile: EnrichedProfile) {}

  async searchRecentTweets(params: SearchParams): Promise<Tweet[]> {
    const tweets = this.profile.rawContent.sourceTweets ?? [];
    const fromMatch = params.query.match(/(?:from:|@)(\w+)/);
    const filtered = fromMatch
      ? tweets.filter((t) => t.authorHandle === fromMatch[1])
      : tweets;
    return filtered
      .slice(0, params.maxResults ?? 10)
      .map((t) => ({
        id: t.id,
        text: t.text,
        authorHandle: t.authorHandle,
        postedAt: t.postedAt,
        ...(t.authorBio ? { authorBio: t.authorBio } : {}),
      }));
  }
}
