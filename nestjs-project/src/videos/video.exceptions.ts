import { DomainException } from '../common/exceptions/domain.exception';

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class VideoNotOwnedException extends DomainException {
  constructor() {
    super('VIDEO_NOT_OWNED', 403, 'You do not own this video');
  }
}

export class VideoInvalidStateException extends DomainException {
  constructor(message = 'Operation is not valid for the current video status') {
    super('VIDEO_INVALID_STATE', 409, message);
  }
}

export class VideoUploadTooLargeException extends DomainException {
  constructor() {
    super('VIDEO_UPLOAD_TOO_LARGE', 400, 'Video exceeds the 10GB size limit');
  }
}

export class UploadCompletionFailedException extends DomainException {
  constructor() {
    super(
      'UPLOAD_COMPLETION_FAILED',
      400,
      'Failed to complete the multipart upload',
    );
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video is not ready yet');
  }
}

export class InvalidRangeException extends DomainException {
  constructor() {
    super('INVALID_RANGE', 416, 'Requested range is not satisfiable');
  }
}
