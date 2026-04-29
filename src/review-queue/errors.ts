export class ReviewQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewQueueError';
  }
}

export class DuplicateProfileError extends ReviewQueueError {
  constructor(public readonly profileId: string) {
    super(`Profile already exists in queue: ${profileId}`);
    this.name = 'DuplicateProfileError';
  }
}

export class NotFoundError extends ReviewQueueError {
  constructor(public readonly profileId: string) {
    super(`Queue item not found: ${profileId}`);
    this.name = 'NotFoundError';
  }
}

export class AlreadyReviewedError extends ReviewQueueError {
  constructor(public readonly profileId: string) {
    super(`Queue item has already been reviewed: ${profileId}`);
    this.name = 'AlreadyReviewedError';
  }
}

export class AnnotationMismatchError extends ReviewQueueError {
  constructor(
    public readonly itemId: string,
    public readonly annotationProfileId: string,
  ) {
    super(
      `Annotation profileId (${annotationProfileId}) does not match item id (${itemId})`,
    );
    this.name = 'AnnotationMismatchError';
  }
}
