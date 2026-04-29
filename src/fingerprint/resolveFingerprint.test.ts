import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { resolveFingerprint } from './resolveFingerprint';
import {
  FingerprintNotFoundError,
  FingerprintValidationError,
  FingerprintCollisionError,
} from './types';
import { ResolvedFingerprintSchema } from './schemas';

// ── Default fixture data ──────────────────────────────────────────────────────

const CORE_SIGNALS = {
  version: '1.0',
  lastCurated: '2026-04-22',
  curator: 'test',
  primarySignals: [{ term: 'multisig', weight: 1.5 }],
  antiSignals: [{ term: 'airdrop', weight: 1.0 }],
};

const CORE_ANTI_SIGNALS = {
  version: '1.0',
  lastCurated: '2026-04-22',
  curator: 'test',
  primarySignals: [] as { term: string; weight: number }[],
  antiSignals: [{ term: 'ponzi', weight: 1.0 }],
};

const CELL_FILE = {
  version: '1.0',
  lastCurated: '2026-04-22',
  curator: 'test',
  cell: 'DeFi & Yield',
  extends: ['core-web3-signals', 'core-web3-anti-signals'],
  primarySignals: [{ term: 'TVL', weight: 1.2 }],
  antiSignals: [{ term: 'rugpull', weight: 1.0 }],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function writeJson(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data));
}

function writeRaw(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

function writeAll(
  dir: string,
  opts: {
    coreSignals?: unknown;
    coreAntiSignals?: unknown;
    cellFile?: unknown;
    skipCore?: boolean;
    skipCoreAnti?: boolean;
    skipCell?: boolean;
  } = {},
): void {
  if (!opts.skipCore)
    writeJson(join(dir, 'core-web3-signals.json'), opts.coreSignals ?? CORE_SIGNALS);
  if (!opts.skipCoreAnti)
    writeJson(join(dir, 'core-web3-anti-signals.json'), opts.coreAntiSignals ?? CORE_ANTI_SIGNALS);
  if (!opts.skipCell)
    writeJson(join(dir, 'cells', 'defi-&-yield.json'), opts.cellFile ?? CELL_FILE);
}

// ── Per-test temp directory ───────────────────────────────────────────────────

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fp-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ── AC-018: core file absent → FingerprintNotFoundError ───────────────────────

describe('AC-018: core file absent', () => {
  it('throws FingerprintNotFoundError when core-web3-signals.json is missing', async () => {
    writeAll(dir, { skipCore: true });
    await expect(resolveFingerprint('DeFi & Yield', dir)).rejects.toThrow(FingerprintNotFoundError);
  });

  it('error.filePath contains core-web3-signals', async () => {
    writeAll(dir, { skipCore: true });
    const err = await resolveFingerprint('DeFi & Yield', dir).catch((e) => e);
    expect(err).toBeInstanceOf(FingerprintNotFoundError);
    expect((err as FingerprintNotFoundError).filePath).toContain('core-web3-signals');
  });
});

// ── AC-019: cell file absent → FingerprintNotFoundError ──────────────────────

describe('AC-019: cell file absent', () => {
  it('throws FingerprintNotFoundError when the cell file is missing', async () => {
    writeAll(dir, { skipCell: true });
    await expect(resolveFingerprint('DeFi & Yield', dir)).rejects.toThrow(FingerprintNotFoundError);
  });

  it('error.filePath contains defi-&-yield', async () => {
    writeAll(dir, { skipCell: true });
    const err = await resolveFingerprint('DeFi & Yield', dir).catch((e) => e);
    expect(err).toBeInstanceOf(FingerprintNotFoundError);
    expect((err as FingerprintNotFoundError).filePath).toContain('defi-&-yield');
  });
});

// ── AC-020: malformed JSON → FingerprintValidationError ──────────────────────

describe('AC-020: malformed JSON', () => {
  it('throws FingerprintValidationError when core-web3-signals.json contains malformed JSON', async () => {
    mkdirSync(join(dir, 'cells'), { recursive: true });
    writeRaw(join(dir, 'core-web3-signals.json'), '{ invalid json');
    writeJson(join(dir, 'core-web3-anti-signals.json'), CORE_ANTI_SIGNALS);
    writeJson(join(dir, 'cells', 'defi-&-yield.json'), CELL_FILE);

    await expect(resolveFingerprint('DeFi & Yield', dir)).rejects.toThrow(
      FingerprintValidationError,
    );
  });

  it('error.filePath contains core-web3-signals', async () => {
    mkdirSync(join(dir, 'cells'), { recursive: true });
    writeRaw(join(dir, 'core-web3-signals.json'), '{ invalid json');
    writeJson(join(dir, 'core-web3-anti-signals.json'), CORE_ANTI_SIGNALS);
    writeJson(join(dir, 'cells', 'defi-&-yield.json'), CELL_FILE);

    const err = await resolveFingerprint('DeFi & Yield', dir).catch((e) => e);
    expect(err).toBeInstanceOf(FingerprintValidationError);
    expect((err as FingerprintValidationError).filePath).toContain('core-web3-signals');
  });
});

// ── AC-021: Zod schema validation failure → FingerprintValidationError ────────

describe('AC-021: Zod validation failure', () => {
  it('throws FingerprintValidationError when a file fails schema validation (weight: -1)', async () => {
    writeAll(dir, {
      coreSignals: { ...CORE_SIGNALS, primarySignals: [{ term: 'test', weight: -1 }] },
    });
    await expect(resolveFingerprint('DeFi & Yield', dir)).rejects.toThrow(
      FingerprintValidationError,
    );
  });

  it('error.filePath contains core-web3-signals', async () => {
    writeAll(dir, {
      coreSignals: { ...CORE_SIGNALS, primarySignals: [{ term: 'test', weight: -1 }] },
    });
    const err = await resolveFingerprint('DeFi & Yield', dir).catch((e) => e);
    expect(err).toBeInstanceOf(FingerprintValidationError);
    expect((err as FingerprintValidationError).filePath).toContain('core-web3-signals');
  });
});

// ── AC-009: extends missing required core name → FingerprintValidationError ───

describe('AC-009: extends missing required core name', () => {
  it('throws FingerprintValidationError when extends omits core-web3-anti-signals', async () => {
    writeAll(dir, {
      cellFile: { ...CELL_FILE, extends: ['core-web3-signals'] },
    });
    await expect(resolveFingerprint('DeFi & Yield', dir)).rejects.toThrow(
      FingerprintValidationError,
    );
  });

  it('throws FingerprintValidationError when extends omits core-web3-signals', async () => {
    writeAll(dir, {
      cellFile: { ...CELL_FILE, extends: ['core-web3-anti-signals'] },
    });
    await expect(resolveFingerprint('DeFi & Yield', dir)).rejects.toThrow(
      FingerprintValidationError,
    );
  });
});

// ── AC-010: extends contains non-core name → FingerprintValidationError ───────

describe('AC-010: extends contains non-core path-format name', () => {
  it('throws FingerprintValidationError when extends contains a cell-path entry', async () => {
    writeAll(dir, {
      cellFile: {
        ...CELL_FILE,
        extends: ['core-web3-signals', 'core-web3-anti-signals', 'cells/trading'],
      },
    });
    await expect(resolveFingerprint('DeFi & Yield', dir)).rejects.toThrow(
      FingerprintValidationError,
    );
  });
});

// ── AC-011: extends references non-existent plain file → FingerprintNotFoundError

describe('AC-011: extends references missing file', () => {
  it('throws FingerprintNotFoundError when a plain-name entry in extends does not exist', async () => {
    writeAll(dir, {
      cellFile: {
        ...CELL_FILE,
        extends: ['core-web3-signals', 'core-web3-anti-signals', 'nonexistent'],
      },
    });
    const err = await resolveFingerprint('DeFi & Yield', dir).catch((e) => e);
    expect(err).toBeInstanceOf(FingerprintNotFoundError);
    expect((err as FingerprintNotFoundError).filePath).toContain('nonexistent');
  });
});

// ── AC-013: cross-core term collision → FingerprintCollisionError ─────────────

describe('AC-013: cross-core term collision', () => {
  it('throws FingerprintCollisionError when the same term appears in both cores primarySignals', async () => {
    writeAll(dir, {
      coreSignals: { ...CORE_SIGNALS, primarySignals: [{ term: 'audit', weight: 1.5 }] },
      coreAntiSignals: { ...CORE_ANTI_SIGNALS, primarySignals: [{ term: 'audit', weight: 1.0 }] },
    });
    await expect(resolveFingerprint('DeFi & Yield', dir)).rejects.toThrow(
      FingerprintCollisionError,
    );
  });

  it('error.term equals the colliding term', async () => {
    writeAll(dir, {
      coreSignals: { ...CORE_SIGNALS, primarySignals: [{ term: 'audit', weight: 1.5 }] },
      coreAntiSignals: { ...CORE_ANTI_SIGNALS, primarySignals: [{ term: 'audit', weight: 1.0 }] },
    });
    const err = await resolveFingerprint('DeFi & Yield', dir).catch((e) => e);
    expect(err).toBeInstanceOf(FingerprintCollisionError);
    expect((err as FingerprintCollisionError).term).toBe('audit');
  });

  it('throws FingerprintCollisionError when the same term appears in both cores antiSignals', async () => {
    writeAll(dir, {
      coreSignals: { ...CORE_SIGNALS, antiSignals: [{ term: 'shared-anti', weight: 1.0 }] },
      coreAntiSignals: { ...CORE_ANTI_SIGNALS, antiSignals: [{ term: 'shared-anti', weight: 1.0 }] },
    });
    await expect(resolveFingerprint('DeFi & Yield', dir)).rejects.toThrow(
      FingerprintCollisionError,
    );
  });
});

// ── AC-014: happy path returns ResolvedFingerprint ────────────────────────────

describe('AC-014: happy path', () => {
  it('resolves without throwing given valid fixture files', async () => {
    writeAll(dir);
    const result = await resolveFingerprint('DeFi & Yield', dir);
    expect(result).toBeDefined();
    expect(result.cell).toBe('DeFi & Yield');
  });
});

// ── AC-012: cell overrides core on term collision ─────────────────────────────

describe('AC-012: cell signal overrides core on term collision', () => {
  it('cell entry wins; core entry replaced; term appears exactly once', async () => {
    writeAll(dir, {
      coreSignals: { ...CORE_SIGNALS, primarySignals: [{ term: 'multisig', weight: 1.0 }] },
      cellFile: {
        ...CELL_FILE,
        primarySignals: [{ term: 'multisig', weight: 2.5, notes: 'cell override' }],
      },
    });
    const result = await resolveFingerprint('DeFi & Yield', dir);
    const matches = result.primarySignals.filter((s) => s.term === 'multisig');
    expect(matches).toHaveLength(1);
    expect(matches[0].weight).toBe(2.5);
  });
});

// ── AC-015: primarySignals union ─────────────────────────────────────────────

describe('AC-015: resolved primarySignals contains terms from core and cell', () => {
  it('includes terms from core-web3-signals and from the cell file', async () => {
    writeAll(dir, {
      coreSignals: { ...CORE_SIGNALS, primarySignals: [{ term: 'multisig', weight: 1.5 }] },
      cellFile: { ...CELL_FILE, primarySignals: [{ term: 'TVL', weight: 1.2 }] },
    });
    const result = await resolveFingerprint('DeFi & Yield', dir);
    const terms = result.primarySignals.map((s) => s.term);
    expect(terms).toContain('multisig');
    expect(terms).toContain('TVL');
  });
});

// ── AC-016: antiSignals union ─────────────────────────────────────────────────

describe('AC-016: resolved antiSignals contains terms from core and cell', () => {
  it('includes anti-signal terms from the core file and from the cell file', async () => {
    // CORE_SIGNALS default has antiSignals:[airdrop]; CORE_ANTI_SIGNALS default has antiSignals:[ponzi]
    // override only the cell so there are no cross-core collisions
    writeAll(dir, {
      cellFile: { ...CELL_FILE, antiSignals: [{ term: 'rugpull', weight: 1.0 }] },
    });
    const result = await resolveFingerprint('DeFi & Yield', dir);
    const terms = result.antiSignals.map((s) => s.term);
    expect(terms).toContain('airdrop');  // from default CORE_SIGNALS.antiSignals
    expect(terms).toContain('rugpull'); // from cell
  });
});

// ── AC-017: cell identity preserved ──────────────────────────────────────────

describe('AC-017: ResolvedFingerprint.cell equals the passed CompetencyCell', () => {
  it('result.cell === "DeFi & Yield"', async () => {
    writeAll(dir);
    const result = await resolveFingerprint('DeFi & Yield', dir);
    expect(result.cell).toBe('DeFi & Yield');
  });
});

// ── AC-022: output validates against ResolvedFingerprintSchema ───────────────

describe('AC-022: output shape valid', () => {
  it('ResolvedFingerprintSchema.parse(result) does not throw', async () => {
    writeAll(dir);
    const result = await resolveFingerprint('DeFi & Yield', dir);
    expect(() => ResolvedFingerprintSchema.parse(result)).not.toThrow();
  });
});

// ── AC-023: all signal weights within (0, 3] ──────────────────────────────────

describe('AC-023: all signal weights within (0, 3]', () => {
  it('every signal in primarySignals and antiSignals has 0 < weight <= 3', async () => {
    writeAll(dir, {
      coreSignals: {
        ...CORE_SIGNALS,
        primarySignals: [
          { term: 'multisig', weight: 0.5 },
          { term: 'zk-proof', weight: 1.5 },
        ],
        antiSignals: [{ term: 'airdrop', weight: 2.0 }],
      },
      coreAntiSignals: {
        ...CORE_ANTI_SIGNALS,
        antiSignals: [{ term: 'ponzi', weight: 3.0 }],
      },
      cellFile: {
        ...CELL_FILE,
        primarySignals: [{ term: 'TVL', weight: 1.0 }],
        antiSignals: [{ term: 'rugpull', weight: 1.0 }],
      },
    });
    const result = await resolveFingerprint('DeFi & Yield', dir);
    expect(result.primarySignals.every((s) => s.weight > 0 && s.weight <= 3)).toBe(true);
    expect(result.antiSignals.every((s) => s.weight > 0 && s.weight <= 3)).toBe(true);
  });
});

// ── AC-024: no duplicate terms in resolved arrays ─────────────────────────────

describe('AC-024: no duplicate terms after merge', () => {
  it('each term appears exactly once in primarySignals when core and cell overlap', async () => {
    writeAll(dir, {
      coreSignals: { ...CORE_SIGNALS, primarySignals: [{ term: 'multisig', weight: 1.0 }] },
      cellFile: {
        ...CELL_FILE,
        primarySignals: [{ term: 'multisig', weight: 2.5 }, { term: 'TVL', weight: 1.2 }],
      },
    });
    const result = await resolveFingerprint('DeFi & Yield', dir);
    const primaryTerms = result.primarySignals.map((s) => s.term);
    expect(new Set(primaryTerms).size).toBe(primaryTerms.length);
    const antiTerms = result.antiSignals.map((s) => s.term);
    expect(new Set(antiTerms).size).toBe(antiTerms.length);
  });
});

// ── AC-025: resolvedAt is valid ISO 8601 ──────────────────────────────────────

describe('AC-025: resolvedAt is valid ISO 8601 datetime', () => {
  it('resolvedAt is a non-empty ISO string at or after pre-call time', async () => {
    writeAll(dir);
    const preCallTime = new Date();
    const result = await resolveFingerprint('DeFi & Yield', dir);
    expect(result.resolvedAt).toBeTruthy();
    const parsed = new Date(result.resolvedAt);
    expect(isNaN(parsed.getTime())).toBe(false);
    expect(parsed >= preCallTime).toBe(true);
  });
});
