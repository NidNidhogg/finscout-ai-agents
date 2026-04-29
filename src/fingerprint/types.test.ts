import {
  FingerprintNotFoundError,
  FingerprintValidationError,
  FingerprintCollisionError,
} from './types';

// ── FingerprintNotFoundError ──────────────────────────────────────────────────

describe('FingerprintNotFoundError', () => {
  test('has name FingerprintNotFoundError', () => {
    const error = new FingerprintNotFoundError('core-web3-signals.json');
    expect(error.name).toBe('FingerprintNotFoundError');
  });

  test('exposes filePath property', () => {
    const error = new FingerprintNotFoundError('core-web3-signals.json');
    expect(error.filePath).toBe('core-web3-signals.json');
  });

  test('is an instance of Error', () => {
    const error = new FingerprintNotFoundError('core-web3-signals.json');
    expect(error).toBeInstanceOf(Error);
  });

  test('message includes filePath', () => {
    const error = new FingerprintNotFoundError('core-web3-signals.json');
    expect(error.message).toContain('core-web3-signals.json');
  });
});

// ── FingerprintValidationError ────────────────────────────────────────────────

describe('FingerprintValidationError', () => {
  test('has name FingerprintValidationError', () => {
    const error = new FingerprintValidationError('core-web3-signals.json');
    expect(error.name).toBe('FingerprintValidationError');
  });

  test('exposes filePath property', () => {
    const error = new FingerprintValidationError('core-web3-signals.json');
    expect(error.filePath).toBe('core-web3-signals.json');
  });

  test('is an instance of Error', () => {
    const error = new FingerprintValidationError('core-web3-signals.json');
    expect(error).toBeInstanceOf(Error);
  });

  test('exposes cause when provided', () => {
    const cause = new Error('original cause');
    const error = new FingerprintValidationError('core-web3-signals.json', cause);
    expect(error.cause).toBe(cause);
  });

  test('message includes filePath', () => {
    const error = new FingerprintValidationError('core-web3-signals.json');
    expect(error.message).toContain('core-web3-signals.json');
  });
});

// ── FingerprintCollisionError ─────────────────────────────────────────────────

describe('FingerprintCollisionError', () => {
  test('has name FingerprintCollisionError', () => {
    const error = new FingerprintCollisionError(
      'audit',
      'core-web3-signals.json',
      'core-web3-anti-signals.json',
    );
    expect(error.name).toBe('FingerprintCollisionError');
  });

  test('exposes term property', () => {
    const error = new FingerprintCollisionError(
      'audit',
      'core-web3-signals.json',
      'core-web3-anti-signals.json',
    );
    expect(error.term).toBe('audit');
  });

  test('exposes file1 and file2 properties', () => {
    const error = new FingerprintCollisionError(
      'audit',
      'core-web3-signals.json',
      'core-web3-anti-signals.json',
    );
    expect(error.file1).toBe('core-web3-signals.json');
    expect(error.file2).toBe('core-web3-anti-signals.json');
  });

  test('is an instance of Error', () => {
    const error = new FingerprintCollisionError(
      'audit',
      'core-web3-signals.json',
      'core-web3-anti-signals.json',
    );
    expect(error).toBeInstanceOf(Error);
  });

  test('message includes term and both file names', () => {
    const error = new FingerprintCollisionError(
      'audit',
      'core-web3-signals.json',
      'core-web3-anti-signals.json',
    );
    expect(error.message).toContain('audit');
    expect(error.message).toContain('core-web3-signals.json');
    expect(error.message).toContain('core-web3-anti-signals.json');
  });
});
