import { ConcreteCompanyResolver } from './ConcreteCompanyResolver';

describe('ConcreteCompanyResolver', () => {
  let resolver: ConcreteCompanyResolver;

  beforeEach(() => {
    resolver = new ConcreteCompanyResolver();
  });

  // ── AC-R1: extracts URL from tweet text ──────────────────────────────────

  describe('AC-R1: resolve() extracts the first non-X URL from tweet text', () => {
    it('returns resolved company with websiteUrl from tweet text', async () => {
      const result = await resolver.resolve('@acmedefi', 'we raised $5M seed round https://acmedefi.io check it out');

      expect(result).not.toBeNull();
      expect(result?.websiteUrl).toBe('https://acmedefi.io');
    });

    it('ignores t.co links and returns the expanded URL', async () => {
      const result = await resolver.resolve('@founder', 'seed round https://t.co/abc123 https://realcompany.com');

      expect(result?.websiteUrl).toBe('https://realcompany.com');
    });

    it('ignores twitter.com links', async () => {
      const result = await resolver.resolve('@founder', 'check https://twitter.com/acmedefi and https://acmedefi.io');

      expect(result?.websiteUrl).toBe('https://acmedefi.io');
    });

    it('ignores x.com links', async () => {
      const result = await resolver.resolve('@founder', 'check https://x.com/acmedefi and https://acmedefi.io');

      expect(result?.websiteUrl).toBe('https://acmedefi.io');
    });
  });

  // ── AC-R2: returns null when no usable URL found ─────────────────────────

  describe('AC-R2: resolve() returns null when no usable URL is present', () => {
    it('returns null for tweet with no URL', async () => {
      const result = await resolver.resolve('@founder', 'we just raised a seed round, very excited!');

      expect(result).toBeNull();
    });

    it('returns null when only t.co links are present', async () => {
      const result = await resolver.resolve('@founder', 'check it out https://t.co/abc123');

      expect(result).toBeNull();
    });

    it('returns null when only twitter.com/x.com links are present', async () => {
      const result = await resolver.resolve('@founder', 'follow us at https://x.com/acmecorp');

      expect(result).toBeNull();
    });
  });

  // ── AC-R3: derives company name from hostname ────────────────────────────

  describe('AC-R3: resolve() derives name from hostname', () => {
    it('strips www. prefix and capitalizes', async () => {
      const result = await resolver.resolve('@founder', 'visit https://www.acmedefi.io');

      expect(result?.name).toBe('Acmedefi');
    });

    it('takes subdomain-stripped hostname segment before last dot', async () => {
      const result = await resolver.resolve('@founder', 'visit https://acmedefi.io');

      expect(result?.name).toBe('Acmedefi');
    });

    it('handles multi-segment hostname', async () => {
      const result = await resolver.resolve('@founder', 'visit https://app.acmecorp.com');

      expect(result?.name).toBe('Acmecorp');
    });
  });

  // ── AC-R4: sets xHandle from authorHandle ────────────────────────────────

  describe('AC-R4: resolve() sets xHandle from authorHandle', () => {
    it('carries authorHandle into xHandle', async () => {
      const result = await resolver.resolve('@acmedefi', 'visit https://acmedefi.io');

      expect(result?.xHandle).toBe('@acmedefi');
    });
  });

  // ── AC-R5: handles trailing punctuation in URLs ──────────────────────────

  describe('AC-R5: resolve() strips trailing punctuation from extracted URLs', () => {
    it('strips trailing period from URL', async () => {
      const result = await resolver.resolve('@founder', 'more at https://acmedefi.io.');

      expect(result?.websiteUrl).toBe('https://acmedefi.io');
    });

    it('strips trailing comma from URL', async () => {
      const result = await resolver.resolve('@founder', 'see https://acmedefi.io, for details');

      expect(result?.websiteUrl).toBe('https://acmedefi.io');
    });
  });

  // ── AC-R6: profileUrl fallback when tweet text has no URL ────────────────

  describe('AC-R6: resolve() uses profileUrl as fallback when tweet text has no usable URL', () => {
    it('returns company with websiteUrl from profileUrl when tweet has no URL', async () => {
      const result = await resolver.resolve('@pinai_io', 'we just raised seed round!', 'https://pinai.io');

      expect(result).not.toBeNull();
      expect(result?.websiteUrl).toBe('https://pinai.io');
      expect(result?.xHandle).toBe('@pinai_io');
    });

    it('derives company name from profileUrl hostname', async () => {
      const result = await resolver.resolve('@pinai_io', 'seed round for defi protocol', 'https://pinai.io');

      expect(result?.name).toBe('Pinai');
    });

    it('tweet text URL takes priority over profileUrl', async () => {
      const result = await resolver.resolve(
        '@founder',
        'we raised seed round, visit https://company.io',
        'https://profilepage.com',
      );

      expect(result?.websiteUrl).toBe('https://company.io');
    });

    it('profileUrl from t.co is ignored — returns null', async () => {
      const result = await resolver.resolve('@founder', 'seed round announcement!', 'https://t.co/abc123');

      expect(result).toBeNull();
    });

    it('profileUrl from x.com is ignored — returns null', async () => {
      const result = await resolver.resolve('@founder', 'seed round!', 'https://x.com/acmecorp');

      expect(result).toBeNull();
    });

    it('invalid profileUrl is silently ignored — returns null', async () => {
      const result = await resolver.resolve('@founder', 'seed round!', 'not-a-url');

      expect(result).toBeNull();
    });

    it('returns null when both tweet text and profileUrl are absent', async () => {
      const result = await resolver.resolve('@founder', 'seed round!');

      expect(result).toBeNull();
    });
  });
});
