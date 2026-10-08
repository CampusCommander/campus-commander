import { UnauthorizedException } from '@nestjs/common';

export class AccessChangedException extends UnauthorizedException {
  constructor() {
    super('Application access changed. Sign in again.');
  }
}
