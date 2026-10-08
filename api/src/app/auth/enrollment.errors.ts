import { ForbiddenException } from '@nestjs/common';

export class EnrollmentBrowserBoundException extends ForbiddenException {
  constructor() {
    super('This pairing code has already started browser sign-in.');
  }
}
