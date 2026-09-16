import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  platformAccessResultSchema,
  platformAccessReviewSchema,
  platformPrincipalPageSchema,
  platformPrincipalSchema,
  type PlatformAccessChange,
  type SessionResponse,
} from '@campus/application-contracts';
import { ConfigurationService } from '../configuration/configuration.service';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class PlatformAccessService {
  constructor(
    private readonly configuration: ConfigurationService,
    private readonly database: DatabaseService,
  ) {}

  private async query(sql: string, values: unknown[]) {
    if (this.configuration.deployment?.phase !== 3)
      throw new NotFoundException();
    try {
      return (await this.database.connection.query(sql, values)).rows[0].result;
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? error.code
          : undefined;
      if (code === '42501') throw new ForbiddenException();
      if (code === 'P0001') throw new ConflictException();
      throw error;
    }
  }

  async list(session: SessionResponse, offset: number, limit: number) {
    return platformPrincipalPageSchema.parse(
      await this.query(
        'SELECT cc.list_platform_principals($1,$2,$3,$4) AS result',
        [
          session.identity.id,
          session.identity.permissionVersion,
          offset,
          limit,
        ],
      ),
    );
  }

  async read(session: SessionResponse, id: string) {
    const result = await this.query(
      'SELECT cc.read_platform_principal($1,$2,$3) AS result',
      [session.identity.id, session.identity.permissionVersion, id],
    );
    if (!result) throw new NotFoundException();
    return platformPrincipalSchema.parse(result);
  }

  async review(
    session: SessionResponse,
    id: string,
    change: PlatformAccessChange,
  ) {
    return platformAccessReviewSchema.parse(
      await this.query(
        'SELECT cc.review_platform_access($1,$2,$3,$4,$5,$6) AS result',
        [
          session.identity.id,
          session.identity.permissionVersion,
          id,
          change.expectedVersion,
          change.enabled,
          JSON.stringify(change.grants),
        ],
      ),
    );
  }

  async change(
    session: SessionResponse,
    id: string,
    change: PlatformAccessChange,
    actorVersion: number,
    correlation: string,
  ) {
    if (actorVersion !== session.identity.permissionVersion)
      throw new ConflictException();
    return platformAccessResultSchema.parse(
      await this.query(
        'SELECT cc.change_platform_access($1,$2,$3,$4,$5,$6,$7) AS result',
        [
          session.identity.id,
          actorVersion,
          id,
          change.expectedVersion,
          change.enabled,
          JSON.stringify(change.grants),
          correlation,
        ],
      ),
    );
  }
}
