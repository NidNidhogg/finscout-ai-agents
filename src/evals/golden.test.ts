import fs from 'fs';
import path from 'path';
import { EnrichedProfileSchema } from '../schema/enrichedProfile';
import { detectSource } from '../services/source-routing';

const GOLDEN_DIR = path.join(__dirname, 'golden');

function fixtureFiles(): string[] {
  return fs.readdirSync(GOLDEN_DIR).filter((f) => f.endsWith('.json'));
}

describe('golden eval fixtures', () => {
  const files = fixtureFiles();

  it('fixture dir is non-empty', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s parses as a valid EnrichedProfile', (file) => {
    const raw = JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, file), 'utf8'));
    expect(() => EnrichedProfileSchema.parse(raw)).not.toThrow();
  });

  it.each(files)('%s routes to a known lead source', (file) => {
    const profile = EnrichedProfileSchema.parse(
      JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, file), 'utf8')),
    );
    expect(detectSource(profile)).not.toBe('unknown');
  });

  it('covers the no-verified-handle guardrail case', () => {
    const profiles = files.map((f) =>
      EnrichedProfileSchema.parse(
        JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, f), 'utf8')),
      ),
    );
    expect(profiles.some((p) => !p.company.xHandle)).toBe(true);
  });
});
