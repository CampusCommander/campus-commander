import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';
import {
  customerSettingsReceiptSchema,
  customerSettingsWriteSchema,
  customerStateSchema,
  type SessionResponse,
} from '@campus/application-contracts';
import { ConfigurationService } from '../configuration/configuration.service';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class CustomerSettingsService {
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
          throw new BadRequestException({ reason: 'invalid-settings' });
        if (
          parsed.data.code === 'P0001' &&
          ['revision-conflict', 'request-conflict'].includes(
            parsed.data.detail ?? '',
          )
        ) {
          throw new ConflictException({ reason: parsed.data.detail });
        }
      }
      throw new ServiceUnavailableException({
        reason: 'customer-store-unavailable',
      });
    }
  }

  async read(session: SessionResponse) {
    return customerStateSchema
      .nullable()
      .parse(
        await this.query(
          'SELECT cc.read_customer_settings($1,$2) AS result',
          this.actor(session),
        ),
      );
  }

  async save(
    session: SessionResponse,
    input: z.infer<typeof customerSettingsWriteSchema>,
    correlation: string,
  ) {
    return customerSettingsReceiptSchema.parse(
      await this.query(
        'SELECT cc.save_customer_settings($1,$2,$3,$4,$5,$6,$7) AS result',
        [
          ...this.actor(session),
          input.customerId,
          input.expectedRevision,
          input.requestId,
          JSON.stringify(input.settings),
          correlation,
        ],
      ),
    );
  }

  async receipt(session: SessionResponse, requestId: string) {
    const result = await this.query(
      'SELECT cc.read_customer_settings_receipt($1,$2,$3) AS result',
      [...this.actor(session), requestId],
    );
    if (!result) throw new NotFoundException({ reason: 'receipt-not-found' });
    return customerSettingsReceiptSchema.parse(result);
  }
}
