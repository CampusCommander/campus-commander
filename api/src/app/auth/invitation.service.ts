import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import {
  invitationSchema,
  invitationBrowserSchema,
  type CreateInvitation,
  type SessionResponse,
} from '@campus/application-contracts';
import { ConfigurationService } from '../configuration/configuration.service';
import { DatabaseService } from '../database/database.service';
import { CacheService } from '../cache/cache.service';

export const invitationCookie = '__Host-cc-invitation';
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');

@Injectable()
export class InvitationService {
  constructor(
    private readonly configuration: ConfigurationService,
    private readonly database: DatabaseService,
    private readonly cache: CacheService,
  ) {}

  private enabled() {
    if (this.configuration.deployment?.phase !== 3)
      throw new NotFoundException();
  }

  private async query(sql: string, values: unknown[]) {
    this.enabled();
    try {
      return await this.database.connection.query(sql, values);
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? error.code
          : undefined;
      if (code === '42501') throw new ForbiddenException();
      if (code === 'P0001' || code === '23505')
        throw new ConflictException(
          'The invitation changed. Refresh and review its current state.',
        );
      throw error;
    }
  }

  async list(session: SessionResponse, correlation: string) {
    const result = await this.query(
      'SELECT cc.list_invitations($1,$2,$3) AS invitations',
      [session.identity.id, session.identity.permissionVersion, correlation],
    );
    return invitationSchema.array().parse(result.rows[0].invitations);
  }

  async create(
    session: SessionResponse,
    input: CreateInvitation,
    correlation: string,
  ) {
    const token = randomBytes(32).toString('hex');
    const result = await this.query(
      'SELECT cc.create_invitation($1,$2,$3,$4,$5,$6,$7,$8) AS id',
      [
        session.identity.id,
        session.identity.permissionVersion,
        input.label,
        input.expectedSubject ?? null,
        hash(token),
        JSON.stringify(input.grants),
        input.expiresInHours,
        correlation,
      ],
    );
    return {
      id: result.rows[0].id,
      url: `${this.configuration.auth.publicOrigin}/invitation#${token}`,
    };
  }

  async revoke(
    session: SessionResponse,
    id: string,
    version: number,
    correlation: string,
  ) {
    const result = await this.query(
      'SELECT cc.revoke_invitation($1,$2,$3,$4,$5) AS revoked',
      [
        session.identity.id,
        session.identity.permissionVersion,
        id,
        version,
        correlation,
      ],
    );
    if (!result.rows[0].revoked) throw new ConflictException();
    return { status: 'revoked' };
  }

  async confirm(
    session: SessionResponse,
    id: string,
    version: number,
    subject: string,
    correlation: string,
  ) {
    const result = await this.query(
      'SELECT cc.confirm_invitation($1,$2,$3,$4,$5,$6) AS principal',
      [
        session.identity.id,
        session.identity.permissionVersion,
        id,
        version,
        subject,
        correlation,
      ],
    );
    if (!result.rows[0].principal) throw new ConflictException();
    return { status: 'accepted' };
  }

  async claim(token: string, source: string, correlation: string) {
    this.enabled();
    // The transport supplies the peer address. Forwarded headers never define this limit.
    if (
      !(await this.cache.reserve(
        `cc:auth:invitation:rate:${hash(source)}`,
        '1',
        2,
      ))
    )
      throw new HttpException('Wait before another invitation request.', 429);
    const browserToken = randomBytes(32).toString('hex');
    const browserHash = hash(browserToken);
    const result = await this.query(
      'SELECT cc.claim_invitation($1,$2,$3,$4) AS id',
      [hash(token), browserHash, this.configuration.auth.issuer, correlation],
    );
    if (!result.rows[0].id) throw new ForbiddenException();
    return { id: result.rows[0].id as string, browserToken, browserHash };
  }

  async verified(
    id: string,
    browserHash: string,
    subject: string,
    name: unknown,
    correlation: string,
  ) {
    const displayName =
      typeof name === 'string' && name.trim()
        ? name.trim().slice(0, 200)
        : 'Invited platform user';
    const result = await this.query(
      'SELECT cc.verify_invitation($1,$2,$3,$4,$5,$6) AS verified',
      [
        id,
        browserHash,
        this.configuration.auth.issuer,
        subject,
        displayName,
        correlation,
      ],
    );
    if (!result.rows[0].verified) throw new ForbiddenException();
  }

  async browser(token: string | undefined, correlation: string) {
    this.enabled();
    if (!token) throw new UnauthorizedException();
    const result = await this.query(
      'SELECT cc.invitation_browser_status($1,$2) AS status',
      [hash(token), correlation],
    );
    if (!result.rows[0].status) throw new UnauthorizedException();
    return invitationBrowserSchema.parse(result.rows[0].status);
  }
}
