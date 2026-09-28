import { lintDraft } from './draft-linter';
import type { EnrichedProfile } from '../schema/enrichedProfile';

const BASE_PROFILE: EnrichedProfile = {
  id: '00000000-0000-4000-8000-000000000001',
  enrichedAt: '2025-01-01T00:00:00Z',
  schemaVersion: '1.0.0',
  sources: {},
  company: {
    name: 'Acme Protocol',
    normalizedName: 'acmeprotocol',
    websiteUrl: 'https://acme.io',
    xHandle: '@acmeprotocol',
  },
  funding: { claimed: {} },
  product: {
    stackMentions: [],
    architectureTerms: [],
    antiSignalTerms: [],
    competencyCellMatches: [],
    evidence: [],
  },
  team: { founders: [{ name: 'Dmitry Sokolov' }] },
  rawContent: { websiteMarkdown: {} },
};

const CLEAN_DRAFT = {
  subject: 'acme settlement latency at $45m tvl',
  body: `Hey Dmitry,
Your acme.io validators queue settlements synchronously, which stalls finality under burst load. Post-raise, that shortcut compounds into a hard wall when TVL doubles. A six-week Minimum Viable Architecture pass removes the synchronous bottleneck before it ships to production. Worth a look at the settlement path this quarter?
Baron`,
};

describe('lintDraft', () => {
  it('passes a clean draft', () => {
    const r = lintDraft(CLEAN_DRAFT, BASE_PROFILE);
    expect(r.violations).toEqual([]);
    expect(r.score).toBe(1);
    expect(r.sentenceCount).toBe(4);
  });

  it('flags uppercase subject', () => {
    const r = lintDraft(
      { ...CLEAN_DRAFT, subject: 'Acme Settlement Latency' },
      BASE_PROFILE,
    );
    expect(r.violations.map((v) => v.rule)).toContain('subject_lowercase');
  });

  it('flags subject over 8 words', () => {
    const r = lintDraft(
      { ...CLEAN_DRAFT, subject: 'one two three four five six seven eight nine' },
      BASE_PROFILE,
    );
    expect(r.violations.map((v) => v.rule)).toContain('subject_word_count');
  });

  it('flags exclamation in subject', () => {
    const r = lintDraft(
      { ...CLEAN_DRAFT, subject: 'acme ships fast!' },
      BASE_PROFILE,
    );
    expect(r.violations.map((v) => v.rule)).toContain('subject_no_exclamation');
  });

  it('flags bracketed placeholders as hard violation', () => {
    const r = lintDraft(
      {
        ...CLEAN_DRAFT,
        body: CLEAN_DRAFT.body.replace('Dmitry', '[first name]'),
      },
      BASE_PROFILE,
    );
    const v = r.violations.find((x) => x.rule === 'no_placeholders');
    expect(v?.severity).toBe('hard');
  });

  it('flags invented @handle when xHandle is null', () => {
    const noHandle = {
      ...BASE_PROFILE,
      company: { ...BASE_PROFILE.company, xHandle: undefined },
    };
    const r = lintDraft(
      {
        ...CLEAN_DRAFT,
        body: CLEAN_DRAFT.body.replace('acme.io', '@acmeprotocol'),
      },
      noHandle,
    );
    const v = r.violations.find((x) => x.rule === 'no_invented_handle');
    expect(v?.severity).toBe('hard');
  });

  it('allows @handle when xHandle is verified', () => {
    const r = lintDraft(
      {
        ...CLEAN_DRAFT,
        body: CLEAN_DRAFT.body.replace('acme.io', '@acmeprotocol'),
      },
      BASE_PROFILE,
    );
    expect(r.violations.map((v) => v.rule)).not.toContain('no_invented_handle');
  });

  it('flags wrong salutation', () => {
    const r = lintDraft(
      { ...CLEAN_DRAFT, body: CLEAN_DRAFT.body.replace('Hey Dmitry,', 'Hi there,') },
      BASE_PROFILE,
    );
    expect(r.violations.map((v) => v.rule)).toContain('salutation_verbatim');
  });

  it('expects "Greetings," when no founder name', () => {
    const noFounder = { ...BASE_PROFILE, team: { founders: [] } };
    const r = lintDraft(
      { ...CLEAN_DRAFT, body: CLEAN_DRAFT.body.replace('Hey Dmitry,', 'Greetings,') },
      noFounder,
    );
    expect(r.violations).toEqual([]);
  });

  it('flags wrong sentence count', () => {
    const body = `Hey Dmitry,
One sentence only.
Baron`;
    const r = lintDraft({ subject: CLEAN_DRAFT.subject, body }, BASE_PROFILE);
    expect(r.violations.map((v) => v.rule)).toContain('sentence_count_4');
    expect(r.sentenceCount).toBe(1);
  });

  it('does not count domains or decimals as sentence ends', () => {
    const r = lintDraft(CLEAN_DRAFT, BASE_PROFILE);
    expect(r.sentenceCount).toBe(4);
  });

  it('flags wrong sign-off', () => {
    const r = lintDraft(
      { ...CLEAN_DRAFT, body: CLEAN_DRAFT.body.replace('\nBaron', '\nBaron Sever, iDECP') },
      BASE_PROFILE,
    );
    expect(r.violations.map((v) => v.rule)).toContain('signoff_baron');
  });

  it('hard violations cap score below soft-only', () => {
    const hard = lintDraft(
      { ...CLEAN_DRAFT, body: CLEAN_DRAFT.body.replace('Dmitry', '[name]') },
      BASE_PROFILE,
    );
    const soft = lintDraft(
      { ...CLEAN_DRAFT, subject: 'Acme Settlement Latency' },
      BASE_PROFILE,
    );
    expect(hard.score).toBeLessThan(soft.score);
    expect(hard.score).toBeLessThan(0.7);
  });
});
