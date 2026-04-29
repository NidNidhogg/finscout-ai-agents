import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import type { FetchedPage, PageFetcher } from '../EnrichmentEngine';

export class FixturePageFetcher implements PageFetcher {
  private readonly basePath: string;

  constructor(basePath = 'data/fixtures/pages') {
    this.basePath = basePath;
  }

  async fetch(url: string): Promise<FetchedPage> {
    const page = await this.loadFixture(url);
    if (!page) throw new Error(`Fixture not found for URL: ${url}`);
    return page;
  }

  async crawl(baseUrl: string): Promise<FetchedPage[]> {
    const { hostname } = new URL(baseUrl);
    const dir = join(this.basePath, hostname);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return [];
    }

    const jsonFiles = files.filter((f) => f.endsWith('.json'));
    const pages: FetchedPage[] = [];
    for (const file of jsonFiles) {
      try {
        const raw = await readFile(join(dir, file), 'utf-8');
        const data = JSON.parse(raw) as Record<string, unknown>;
        pages.push({ ...(data as Omit<FetchedPage, 'fetchedAt'>), fetchedAt: new Date(data.fetchedAt as string) });
      } catch {
        // skip unreadable fixtures
      }
    }
    return pages;
  }

  private async loadFixture(url: string): Promise<FetchedPage | null> {
    const parsed = new URL(url);
    const { hostname, pathname } = parsed;
    const pathSegment =
      pathname === '/' ? 'index' : pathname.slice(1).replace(/\//g, '-');
    const filePath = join(this.basePath, hostname, `${pathSegment}.json`);
    try {
      const raw = await readFile(filePath, 'utf-8');
      const data = JSON.parse(raw) as Record<string, unknown>;
      return { ...(data as Omit<FetchedPage, 'fetchedAt'>), fetchedAt: new Date(data.fetchedAt as string) };
    } catch {
      return null;
    }
  }
}
