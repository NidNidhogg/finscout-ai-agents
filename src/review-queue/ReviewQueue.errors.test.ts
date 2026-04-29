import {
  ReviewQueueError,
  DuplicateProfileError,
  NotFoundError,
  AlreadyReviewedError,
  AnnotationMismatchError,
} from './errors';

describe('Error class hierarchy', () => {
  it('DuplicateProfileError extends ReviewQueueError', () => {
    const err = new DuplicateProfileError('abc');
    expect(err).toBeInstanceOf(ReviewQueueError);
    expect(err).toBeInstanceOf(DuplicateProfileError);
    expect(err.profileId).toBe('abc');
    expect(err.name).toBe('DuplicateProfileError');
  });

  it('NotFoundError extends ReviewQueueError', () => {
    const err = new NotFoundError('abc');
    expect(err).toBeInstanceOf(ReviewQueueError);
    expect(err.profileId).toBe('abc');
    expect(err.name).toBe('NotFoundError');
  });

  it('AlreadyReviewedError extends ReviewQueueError', () => {
    const err = new AlreadyReviewedError('abc');
    expect(err).toBeInstanceOf(ReviewQueueError);
    expect(err.profileId).toBe('abc');
    expect(err.name).toBe('AlreadyReviewedError');
  });

  it('AnnotationMismatchError extends ReviewQueueError with itemId and annotationProfileId', () => {
    const err = new AnnotationMismatchError('item-1', 'annotation-2');
    expect(err).toBeInstanceOf(ReviewQueueError);
    expect(err.itemId).toBe('item-1');
    expect(err.annotationProfileId).toBe('annotation-2');
    expect(err.name).toBe('AnnotationMismatchError');
  });
});
