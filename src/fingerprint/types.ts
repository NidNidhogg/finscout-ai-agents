export class FingerprintNotFoundError extends Error {
  constructor(public readonly filePath: string) {
    super(`Fingerprint file not found: ${filePath}`);
    this.name = 'FingerprintNotFoundError';
  }
}

export class FingerprintValidationError extends Error {
  public readonly filePath: string;
  public override readonly cause?: unknown;

  constructor(filePath: string, cause?: unknown) {
    super(`Fingerprint validation failed for: ${filePath}`);
    this.name = 'FingerprintValidationError';
    this.filePath = filePath;
    this.cause = cause;
  }
}

export class FingerprintCollisionError extends Error {
  constructor(
    public readonly term: string,
    public readonly file1: string,
    public readonly file2: string,
  ) {
    super(`Term collision between ${file1} and ${file2}: "${term}"`);
    this.name = 'FingerprintCollisionError';
  }
}
