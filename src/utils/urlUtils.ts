const URL_RESOLVE_TIMEOUT_MS = 8_000;
const TRACKING_PARAM = /^(utm_|fbclid$|gclid$|mc_eid$|ref$)/;

function addScheme(raw: string): string {
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

export function stripTrackingParams(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAM.test(key)) u.searchParams.delete(key);
    }
    const path = u.pathname.replace(/\/$/, '');
    return u.origin + path + u.search;
  } catch {
    return rawUrl;
  }
}

/**
 * Follow redirects to the canonical URL, strip tracking params.
 * Returns null if the URL is dead (non-2xx, DNS failure, timeout).
 * Falls back from HEAD to the normalised input on 405 (server rejects HEAD).
 */
export async function resolveCanonicalUrl(raw: string): Promise<string | null> {
  const url = addScheme(raw);
  try {
    const resp = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(URL_RESOLVE_TIMEOUT_MS),
    });
    if (resp.status === 405) return stripTrackingParams(url); // live but HEAD blocked
    if (!resp.ok) return null;
    return stripTrackingParams(resp.url);
  } catch {
    return null; // timeout, ECONNREFUSED, DNS NXDOMAIN, etc.
  }
}
