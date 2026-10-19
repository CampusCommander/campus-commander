import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { Jobs } from './jobs';

@Injectable()
export class JobsService extends Jobs {
  constructor(database: DatabaseService) {
    super(database);
  }
}
