import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';
import {
  schoolDefinitionSchema,
  schoolDefinitionPageSchema,
  schoolPreviewSchema,
  schoolReviewSchema,
  schoolAuditPageSchema,
  type SessionResponse,
} from '@campus/application-contracts';
import { ConfigurationService } from '../configuration/configuration.service';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class SchoolsService {
  constructor(
    private readonly configuration: ConfigurationService,
    private readonly database: DatabaseService,
  ) {}

  private actor(session: SessionResponse) {
    if (this.configuration.deployment?.phase !== 3)
      throw new NotFoundException();
    return [session.identity.id, session.identity.permissionVersion];
  }

  private async query(sql: string, values: unknown[]) {
    try {
      return (await this.database.connection.query(sql, values)).rows[0]?.[
        'result'
      ];
    } catch (error) {
      const parsed = z
        .object({ code: z.string(), detail: z.string().optional() })
        .safeParse(error);
      if (parsed.success) {
        if (parsed.data.code === '42501')
          throw new ForbiddenException({ reason: 'forbidden' });
        if (parsed.data.code === '22023')
          throw new BadRequestException({ reason: 'invalid-school' });
        if (parsed.data.code === '23505')
          throw new ConflictException({ reason: 'review-conflict' });
        if (parsed.data.code === 'P0001') {
          if (parsed.data.detail === 'school-review-limit')
            throw new HttpException({ reason: parsed.data.detail }, 429);
          if (
            [
              'school-changed',
              'school-access-changed',
              'references-changed',
            ].includes(parsed.data.detail ?? '')
          )
            throw new ConflictException({ reason: parsed.data.detail });
        }
      }
      throw new ServiceUnavailableException({
        reason: 'school-store-unavailable',
      });
    }
  }

  async list(session: SessionResponse, offset: number, limit: number) {
    return schoolDefinitionPageSchema.parse(
      await this.query(
        'SELECT cc.list_school_definitions($1,$2,$3,$4) AS result',
        [...this.actor(session), offset, limit],
      ),
    );
  }
  async read(session: SessionResponse, id: string) {
    const result = await this.query(
      'SELECT cc.read_school_definition($1,$2,$3) AS result',
      [...this.actor(session), id],
    );
    if (!result) throw new NotFoundException({ reason: 'school-not-found' });
    return schoolDefinitionSchema.parse(result);
  }
  async audit(session: SessionResponse, id: string, offset: number) {
    const result = await this.query(
      'SELECT cc.list_school_audit($1,$2,$3,$4) AS result',
      [...this.actor(session), id, offset],
    );
    if (!result) throw new NotFoundException({ reason: 'school-not-found' });
    return schoolAuditPageSchema.parse(result);
  }
  async preview(
    session: SessionResponse,
    input: z.infer<typeof schoolPreviewSchema>,
    correlationId: string,
  ) {
    return schoolReviewSchema.parse(
      await this.query(
        'SELECT cc.preview_school_definition($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS result',
        [
          ...this.actor(session),
          input.schoolId,
          input.customerId,
          input.expectedRevision,
          input.referenceRevision,
          input.name,
          JSON.stringify(input.rules),
          input.id,
          correlationId,
        ],
      ),
    );
  }
  async confirm(session: SessionResponse, id: string) {
    return schoolReviewSchema.parse(
      await this.query(
        'SELECT cc.confirm_school_definition($1,$2,$3) AS result',
        [...this.actor(session), id],
      ),
    );
  }
  async review(session: SessionResponse, id: string) {
    const result = await this.query(
      'SELECT cc.read_school_review($1,$2,$3) AS result',
      [...this.actor(session), id],
    );
    if (!result) throw new NotFoundException({ reason: 'review-not-found' });
    return schoolReviewSchema.parse(result);
  }
}
