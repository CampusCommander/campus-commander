import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import {
  userByIdsSchema,
  userDomainRefreshSchema,
  userQuerySchema,
  userSelectionChangeSchema,
  userSelectionKeySchema,
  userSelectionResolveSchema,
  type SessionResponse,
} from '@campus/application-contracts';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard';
import { AuthService } from '../auth/auth.service';
import { userSelectionRefreshStatus } from './user-selection-refresh';
import { UsersService } from './users.service';

const userIdSchema = z.string().min(1).max(128);

@Controller('api/users')
@UseGuards(AuthGuard)
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly auth: AuthService,
  ) {}

  /** Resolve the connected customer, then require users:read for it. */
  private async current(request: AuthenticatedRequest) {
    return this.currentFor(request.session, request.correlationId);
  }

  private async currentFor(session: SessionResponse, correlationId: string) {
    const sync = await this.users.sync(session);
    if (sync)
      await this.auth.authorize(
        session,
        'users:read',
        { kind: 'district', customerId: sync.customerId },
        correlationId,
      );
    return sync;
  }

  @Get('sync')
  async sync(@Req() request: AuthenticatedRequest) {
    return { sync: await this.current(request) };
  }

  /** Refresh Users: start one full user sync. */
  @Post('sync')
  async requestSync(@Req() request: AuthenticatedRequest) {
    const current = await this.current(request);
    if (!current)
      throw new ConflictException({ reason: 'connection-required' });
    return {
      sync: await this.users.requestSync(
        request.session,
        current,
        request.correlationId,
      ),
    };
  }

  @Post('query')
  @HttpCode(200)
  async query(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = userQuerySchema.parse(body);
    await this.current(request);
    return {
      page: await this.users.page(
        request.session,
        input,
        request.correlationId,
      ),
    };
  }

  /** Rows that a refresh signal names. The client sends only the rows its grid holds (D7). */
  @Post('by-ids')
  @HttpCode(200)
  async byIds(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = userByIdsSchema.parse(body);
    await this.current(request);
    return {
      rows: await this.users.rowsById(request.session, input.userIds),
    };
  }

  @Post('freshness')
  @HttpCode(200)
  async freshness(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = userQuerySchema.parse(body);
    await this.current(request);
    return {
      freshness: await this.users.freshness(request.session, input),
    };
  }

  @Post('selection')
  @HttpCode(200)
  async selection(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const key = userSelectionKeySchema.parse(body);
    await this.current(request);
    return { selection: await this.users.selection(request.session, key) };
  }

  @Post('selection/ops')
  @HttpCode(200)
  async changeSelection(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    const input = userSelectionChangeSchema.parse(body);
    await this.current(request);
    return {
      selection: await this.users.changeSelection(
        request.session,
        { gridId: input.gridId, tabId: input.tabId },
        input.ops,
      ),
    };
  }

  @Post('selection/resolve')
  @HttpCode(200)
  async resolveSelection(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    const input = userSelectionResolveSchema.parse(body);
    await this.current(request);
    return {
      selected: await this.users.resolveSelection(
        request.session,
        { gridId: input.gridId, tabId: input.tabId },
        input.rowIds,
      ),
    };
  }

  /** Re-read the selected users from Google. */
  @Post('selection/refresh')
  async refreshSelection(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const key = userSelectionKeySchema.parse(body);
    const current = await this.current(request);
    if (!current)
      throw new ConflictException({ reason: 'connection-required' });
    const refresh = await this.users.refreshSelection(
      request.session,
      current.customerId,
      key,
      request.correlationId,
    );
    // A fully claimed selection starts no job and answers 200.
    response.status(userSelectionRefreshStatus(refresh));
    return { refresh };
  }

  /** Run the full user sync, then read the domain details again. */
  @Post('domain/refresh')
  async refreshDomain(@Req() request: AuthenticatedRequest) {
    const current = await this.current(request);
    if (!current)
      throw new ConflictException({ reason: 'connection-required' });
    return {
      refresh: userDomainRefreshSchema.parse(
        await this.users.domainRefresh.request(
          request.session,
          current,
          request.correlationId,
        ),
      ),
    };
  }

  @Get('org-units')
  async orgUnits(@Req() request: AuthenticatedRequest) {
    await this.current(request);
    return { orgUnits: await this.users.orgUnits(request.session) };
  }

  /** The category read of B section 10 row 1, by the cache rules of B section 9. */
  @Get('attribute-categories')
  async attributeCategories(@Req() request: AuthenticatedRequest) {
    await this.current(request);
    return this.users.attributeCategories(request.session);
  }

  /** Read the categories from Google now (B section 9). */
  @Post('attribute-categories/refresh')
  async refreshAttributeCategories(@Req() request: AuthenticatedRequest) {
    await this.current(request);
    return this.users.refreshAttributeCategories(request.session);
  }

  @Get(':userId')
  async user(
    @Req() request: AuthenticatedRequest,
    @Param('userId') userId: string,
  ) {
    const id = userIdSchema.parse(userId);
    await this.current(request);
    return { user: await this.users.user(request.session, id) };
  }
}
