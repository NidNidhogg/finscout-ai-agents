import { z } from 'zod';
import {
  CoreFingerprintFileSchema,
  CellFingerprintFileSchema,
} from './schemas';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCoreFile(overrides: Record<string, unknown> = {}): unknown {
  return {
    version: '1.0',
    lastCurated: '2026-04-22',
    curator: 'dmitriy',
    primarySignals: [{ term: 'multisig', weight: 1.5 }],
    antiSignals: [{ term: 'airdrop', weight: 1.0 }],
    ...overrides,
  };
}

function makeCellFile(overrides: Record<string, unknown> = {}): unknown {
  return {
    version: '1.0',
    lastCurated: '2026-04-22',
    curator: 'dmitriy',
    cell: 'DeFi & Yield',
    extends: ['core-web3-signals', 'core-web3-anti-signals'],
    primarySignals: [{ term: 'TVL', weight: 1.2 }],
    antiSignals: [{ term: 'rugpull', weight: 1.0 }],
    ...overrides,
  };
}

// ── CoreFingerprintFileSchema ─────────────────────────────────────────────────

describe('CoreFingerprintFileSchema', () => {
  test('AC-001: parses a valid core file object', () => {
    const result = CoreFingerprintFileSchema.parse(makeCoreFile());
    expect(result.version).toBe('1.0');
    expect(result.primarySignals[0].term).toBe('multisig');
  });

  test('AC-003: rejects an object with an extends field', () => {
    expect(() =>
      CoreFingerprintFileSchema.parse(makeCoreFile({ extends: ['core-web3-signals'] })),
    ).toThrow(z.ZodError);
  });

  test('AC-007: rejects version other than "1.0"', () => {
    const result = CoreFingerprintFileSchema.safeParse(makeCoreFile({ version: '2.0' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('version'))).toBe(true);
    }
  });
});

// ── CellFingerprintFileSchema ─────────────────────────────────────────────────

describe('CellFingerprintFileSchema', () => {
  test('AC-002: parses a valid cell file object', () => {
    const result = CellFingerprintFileSchema.parse(makeCellFile());
    expect(result.cell).toBe('DeFi & Yield');
    expect(result.extends).toContain('core-web3-signals');
    expect(result.extends).toContain('core-web3-anti-signals');
  });

  test('AC-004: rejects an object missing the extends field', () => {
    const base = makeCellFile() as Record<string, unknown>;
    delete base['extends'];
    expect(() => CellFingerprintFileSchema.parse(base)).toThrow(z.ZodError);
  });

  test('AC-005: rejects an extends array with fewer than 2 entries', () => {
    const result = CellFingerprintFileSchema.safeParse(
      makeCellFile({ extends: ['core-web3-signals'] }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('extends'))).toBe(true);
    }
  });

  test('AC-006: rejects an object missing the cell field', () => {
    const base = makeCellFile() as Record<string, unknown>;
    delete base['cell'];
    expect(() => CellFingerprintFileSchema.parse(base)).toThrow(z.ZodError);
  });

  test('AC-007: rejects version other than "1.0"', () => {
    const result = CellFingerprintFileSchema.safeParse(makeCellFile({ version: '2.0' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('version'))).toBe(true);
    }
  });
});

// ── SignalSchema — weight bounds ──────────────────────────────────────────────

describe('SignalSchema — weight bounds (AC-008)', () => {
  test('rejects weight of 0', () => {
    expect(() =>
      CoreFingerprintFileSchema.parse(makeCoreFile({ primarySignals: [{ term: 'test', weight: 0 }] })),
    ).toThrow(z.ZodError);
  });

  test('rejects negative weight', () => {
    expect(() =>
      CoreFingerprintFileSchema.parse(makeCoreFile({ primarySignals: [{ term: 'test', weight: -1 }] })),
    ).toThrow(z.ZodError);
  });

  test('rejects weight above 3', () => {
    expect(() =>
      CoreFingerprintFileSchema.parse(makeCoreFile({ primarySignals: [{ term: 'test', weight: 3.1 }] })),
    ).toThrow(z.ZodError);
  });

  test('accepts weight of exactly 3', () => {
    expect(() =>
      CoreFingerprintFileSchema.parse(makeCoreFile({ primarySignals: [{ term: 'test', weight: 3 }] })),
    ).not.toThrow();
  });
});
