import type { CompanyResolver, ResolvedCompany } from './XSignalSource';

const EXCLUDED_HOSTS = new Set(['t.co', 'twitter.com', 'x.com']);
const URL_REGEX = /https?:\/\/[^\s,)>'"]+/g;

function stripTrailingPunctuation(url: string): string {
  return url.replace(/[.,;:!?]+$/, '');
}

function deriveNameFromHostname(hostname: string): string {
  const withoutWww = hostname.replace(/^www\./, '');
  const parts = withoutWww.split('.');
  const segment = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
  return segment.charAt(0).toUpperCase() + segment.slice(1);
}

export class ConcreteCompanyResolver implements CompanyResolver {
  async resolve(authorHandle: string, tweetText: string, profileUrl?: string): Promise<ResolvedCompany | null> {
    // Check tweet text first
    const matches = tweetText.match(URL_REGEX) ?? [];
    for (const raw of matches) {
      const cleaned = stripTrailingPunctuation(raw);
      let parsed: URL;
      try {
        parsed = new URL(cleaned);
      } catch {
        continue;
      }
      const hostname = parsed.hostname.toLowerCase();
      if (EXCLUDED_HOSTS.has(hostname)) continue;
      return { websiteUrl: cleaned, name: deriveNameFromHostname(hostname), xHandle: authorHandle };
    }

    // Fall back to X profile URL (already expanded by the API — no t.co)
    if (profileUrl) {
      try {
        const parsed = new URL(profileUrl);
        const hostname = parsed.hostname.toLowerCase();
        if (!EXCLUDED_HOSTS.has(hostname)) {
          return { websiteUrl: profileUrl, name: deriveNameFromHostname(hostname), xHandle: authorHandle };
        }
      } catch {
        // invalid URL — ignore
      }
    }

    return null;
  }
}
