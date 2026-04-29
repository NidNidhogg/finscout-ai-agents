import { readFile } from 'fs/promises';
import { join } from 'path';
import type { CompetencyCell } from '../schema/enrichedProfile';
import {
  CoreFingerprintFileSchema,
  CellFingerprintFileSchema,
  type CoreFingerprintFile,
  type CellFingerprintFile,
  type ResolvedFingerprint,
  type Signal,
} from './schemas';
import {
  FingerprintNotFoundError,
  FingerprintValidationError,
  FingerprintCollisionError,
} from './types';

const CELL_FILENAME: Record<CompetencyCell, string> = {
  'DeFi & Yield': 'defi-&-yield.json',
  Trading: 'trading.json',
  Infrastructure: 'infrastructure.json',
  Security: 'security.json',
  'Payment Rails': 'payment-rails.json',
};

const REQUIRED_CORE_NAMES = ['core-web3-signals', 'core-web3-anti-signals'] as const;
type CoreName = (typeof REQUIRED_CORE_NAMES)[number];

async function loadCoreFile(filePath: string): Promise<CoreFingerprintFile> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch {
    throw new FingerprintNotFoundError(filePath);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new FingerprintValidationError(filePath, err);
  }
  try {
    return CoreFingerprintFileSchema.parse(parsed);
  } catch (err) {
    throw new FingerprintValidationError(filePath, err);
  }
}

async function loadCellFile(filePath: string): Promise<CellFingerprintFile> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch {
    throw new FingerprintNotFoundError(filePath);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new FingerprintValidationError(filePath, err);
  }
  try {
    return CellFingerprintFileSchema.parse(parsed);
  } catch (err) {
    throw new FingerprintValidationError(filePath, err);
  }
}

function checkCoreCollisions(
  coreSignals: CoreFingerprintFile,
  coreAntiSignals: CoreFingerprintFile,
): void {
  const primaryTerms = new Set(coreSignals.primarySignals.map((s) => s.term));
  for (const signal of coreAntiSignals.primarySignals) {
    if (primaryTerms.has(signal.term)) {
      throw new FingerprintCollisionError(
        signal.term,
        'core-web3-signals',
        'core-web3-anti-signals',
      );
    }
  }
  const antiTerms = new Set(coreSignals.antiSignals.map((s) => s.term));
  for (const signal of coreAntiSignals.antiSignals) {
    if (antiTerms.has(signal.term)) {
      throw new FingerprintCollisionError(
        signal.term,
        'core-web3-signals',
        'core-web3-anti-signals',
      );
    }
  }
}

async function validateCellExtends(
  extendsArray: string[],
  cellFilePath: string,
  basePath: string,
): Promise<void> {
  if (!extendsArray.includes('core-web3-signals')) {
    throw new FingerprintValidationError(
      cellFilePath,
      'extends must include "core-web3-signals"',
    );
  }
  if (!extendsArray.includes('core-web3-anti-signals')) {
    throw new FingerprintValidationError(
      cellFilePath,
      'extends must include "core-web3-anti-signals"',
    );
  }
  for (const name of extendsArray) {
    if (REQUIRED_CORE_NAMES.includes(name as CoreName)) continue;
    // Path-format names are cell-extends-cell attempts — rejected immediately
    if (name.includes('/')) {
      throw new FingerprintValidationError(
        cellFilePath,
        `Cell inheritance is not supported in Phase 1: "${name}"`,
      );
    }
    // Plain name: attempt to locate the file — if absent, not-found error
    const extraFilePath = join(basePath, `${name}.json`);
    try {
      await readFile(extraFilePath);
    } catch {
      throw new FingerprintNotFoundError(extraFilePath);
    }
    // File exists but is not one of the two allowed core references
    throw new FingerprintValidationError(
      cellFilePath,
      `Invalid extension target (only the two core files are allowed): "${name}"`,
    );
  }
}

function mergeSignals(...sources: Signal[][]): Signal[] {
  const map = new Map<string, Signal>();
  for (const source of sources) {
    for (const signal of source) {
      map.set(signal.term, signal);
    }
  }
  return [...map.values()];
}

export async function resolveFingerprint(
  cell: CompetencyCell,
  basePath: string = 'data/fingerprints',
): Promise<ResolvedFingerprint> {
  const coreSignals = await loadCoreFile(join(basePath, 'core-web3-signals.json'));
  const coreAntiSignals = await loadCoreFile(join(basePath, 'core-web3-anti-signals.json'));

  checkCoreCollisions(coreSignals, coreAntiSignals);

  const cellFilename = CELL_FILENAME[cell];
  const cellFilePath = join(basePath, 'cells', cellFilename);
  const cellFile = await loadCellFile(cellFilePath);

  await validateCellExtends(cellFile.extends, cellFilePath, basePath);

  const primarySignals = mergeSignals(
    coreSignals.primarySignals,
    coreAntiSignals.primarySignals,
    cellFile.primarySignals,
  );

  const antiSignals = mergeSignals(
    coreSignals.antiSignals,
    coreAntiSignals.antiSignals,
    cellFile.antiSignals,
  );

  return {
    cell,
    resolvedAt: new Date().toISOString(),
    primarySignals,
    antiSignals,
  };
}
