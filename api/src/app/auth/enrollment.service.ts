import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { CacheService } from '../cache/cache.service';
import { DatabaseService } from '../database/database.service';
import { ConfigurationService } from '../configuration/configuration.service';

const opaque = () => randomBytes(32).toString('hex');
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const identifier = z.string().regex(/^[a-f0-9]{64}$/);
const candidateSchema = z.strictObject({
  issuer: z.string(),
  subject: z.string().min(1).max(512),
  displayName: z.string().min(1).max(200),
});
const attemptSchema = z.strictObject({
  id: identifier,
  codeHash: identifier,
  expires: z.number(),
  failures: z.number(),
  stage: z.enum(['pending', 'paired', 'verified', 'failed']),
  browserHash: identifier.optional(),
  candidate: candidateSchema.optional(),
});
const activeKey = 'cc:auth:enrollment:active';
const browserKey = (token: string) =>
  `cc:auth:enrollment:browser:${hash(token)}`;
export const enrollmentCookie = '__Host-cc-enrollment';

@Injectable()
export class EnrollmentService {
  constructor(
    private readonly cache: CacheService,
    private readonly database: DatabaseService,
    private readonly configuration: ConfigurationService,
  ) {}

  private async empty() {
    if (!this.configuration.auth) throw new UnauthorizedException();
    const existing = await this.database.connection.query(
      'SELECT id FROM cc.application_principals LIMIT 1',
    );
    if (existing.rowCount)
      throw new ConflictException(
        'Administrator enrollment already completed.',
      );
  }
  private async active(id?: string) {
    const raw = await this.cache.get(activeKey);
    if (!raw)
      throw new UnauthorizedException(
        'Enrollment expired. Resume the installer.',
      );
    const attempt = attemptSchema.parse(JSON.parse(raw));
    if (attempt.expires <= Date.now() || (id && attempt.id !== id))
      throw new UnauthorizedException();
    return { raw, attempt };
  }
  async operator(input: unknown) {
    const request = z
      .discriminatedUnion('action', [
        z.strictObject({ action: z.literal('start') }),
        z.strictObject({
          action: z.literal('cancel'),
          id: identifier.optional(),
        }),
        z.strictObject({ action: z.literal('inspect'), id: identifier }),
        z.strictObject({ action: z.literal('claim'), id: identifier }),
      ])
      .parse(input);
    if (request.action === 'cancel') {
      const raw = await this.cache.get(activeKey);
      if (
        raw &&
        (!request.id || attemptSchema.parse(JSON.parse(raw)).id === request.id)
      )
        await this.cache.release(activeKey, raw);
      return { status: 'cancelled' };
    }
    await this.empty();
    if (request.action === 'start') {
      const code = opaque(),
        id = opaque();
      const attempt = {
        id,
        codeHash: hash(code),
        expires: Date.now() + 600000,
        failures: 0,
        stage: 'pending',
      };
      if (!(await this.cache.reserve(activeKey, JSON.stringify(attempt), 600)))
        throw new ConflictException('An enrollment attempt is already active.');
      return { id, code, expires: attempt.expires };
    }
    const { raw, attempt } = await this.active(request.id);
    if (request.action === 'claim') {
      if (
        attempt.stage !== 'verified' ||
        !attempt.candidate ||
        !(await this.cache.release(activeKey, raw))
      )
        throw new ConflictException();
      return { status: 'claimed', candidate: attempt.candidate };
    }
    return { status: attempt.stage, candidate: attempt.candidate };
  }
  async pair(code: unknown) {
    const parsed = identifier.safeParse(code);
    if (!parsed.success) throw new ForbiddenException();
    await this.empty();
    const { raw, attempt } = await this.active();
    if (attempt.stage !== 'pending' || attempt.failures >= 10)
      throw new ForbiddenException();
    if (attempt.codeHash !== hash(parsed.data)) {
      await this.cache.replace(
        activeKey,
        raw,
        JSON.stringify({ ...attempt, failures: attempt.failures + 1 }),
      );
      throw new ForbiddenException();
    }
    const token = opaque();
    const next = { ...attempt, stage: 'paired', browserHash: hash(token) };
    if (!(await this.cache.replace(activeKey, raw, JSON.stringify(next))))
      throw new ConflictException();
    await this.cache.set(
      browserKey(token),
      JSON.stringify({ id: attempt.id }),
      Math.max(1, Math.floor((attempt.expires - Date.now()) / 1000)),
    );
    return { id: attempt.id, token };
  }
  async verified(id: string, subject: string, name: unknown) {
    await this.empty();
    const { raw, attempt } = await this.active(id);
    if (attempt.stage !== 'paired' || !attempt.browserHash)
      throw new UnauthorizedException();
    const candidate = candidateSchema.parse({
      issuer: this.configuration.auth.issuer,
      subject,
      displayName:
        typeof name === 'string' && name.trim()
          ? name.trim().slice(0, 200)
          : 'Installation administrator',
    });
    if (
      !(await this.cache.replace(
        activeKey,
        raw,
        JSON.stringify({ ...attempt, stage: 'verified', candidate }),
      ))
    )
      throw new UnauthorizedException();
    await this.cache.set(
      `cc:auth:enrollment:browser:${attempt.browserHash}`,
      JSON.stringify({ id, candidate }),
      Math.max(1, Math.floor((attempt.expires - Date.now()) / 1000)),
    );
  }
  async failed(id: string) {
    const { raw, attempt } = await this.active(id);
    if (attempt.stage === 'paired')
      await this.cache.replace(
        activeKey,
        raw,
        JSON.stringify({ ...attempt, stage: 'failed' }),
      );
  }
  async browser(token: string | undefined) {
    if (!token) throw new UnauthorizedException();
    const raw = await this.cache.get(browserKey(token));
    if (!raw) throw new UnauthorizedException();
    const record = z
      .strictObject({ id: identifier, candidate: candidateSchema.optional() })
      .parse(JSON.parse(raw));
    if (record.candidate) {
      const found = await this.database.connection.query(
        'SELECT id FROM cc.application_principals WHERE issuer=$1 AND subject=$2 AND enabled',
        [record.candidate.issuer, record.candidate.subject],
      );
      if (found.rowCount) return { status: 'complete' };
    }
    if (record.candidate && !(await this.cache.get(activeKey)))
      return { status: 'awaiting-confirmation' };
    const { attempt } = await this.active(record.id);
    return {
      status:
        attempt.stage === 'verified'
          ? 'awaiting-confirmation'
          : 'awaiting-sign-in',
    };
  }
}
