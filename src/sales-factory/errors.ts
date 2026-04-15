export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

export class ClockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClockError';
    Object.setPrototypeOf(this, ClockError.prototype);
  }
}
