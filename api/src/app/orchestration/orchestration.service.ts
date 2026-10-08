import { Injectable } from '@nestjs/common';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import { ConfigurationService } from '../configuration/configuration.service';
import {
  serviceRequest,
  ServiceResponseError,
  ServiceTimeoutError,
} from '../configuration/service-http';

@Injectable()
export class OrchestrationService {
  constructor(private readonly configuration: ConfigurationService) {}

  private async request(
    path: string,
    method?: string,
    body?: string,
    contentType?: string,
  ) {
    const service = this.configuration.deployment?.services.kestra;
    if (!service) throw new Error('Orchestration is not configured.');
    const credentials = z
      .strictObject({
        username: z.string().min(1),
        password: z.string().min(1),
      })
      .parse(
        JSON.parse(
          this.configuration.secret(service.authSecretRef).toString('utf8'),
        ),
      );
    const authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;
    return serviceRequest(
      this.configuration,
      service,
      path,
      authorization,
      method,
      body,
      contentType,
    );
  }

  async healthy() {
    await this.request('/api/v1/main/flows/search?size=1');
    return true;
  }

  /** Create or update one repository flow before each execution. */
  private async deployFlow(file: string, id: string) {
    const flow = await readFile(
      resolve(process.cwd(), 'deployment/kestra', file),
      'utf8',
    );
    const flowPath = `/api/v1/main/flows/campus.application/${id}`;
    let exists = true;
    try {
      await this.request(flowPath);
    } catch (error) {
      if (error instanceof ServiceResponseError && error.status === 404)
        exists = false;
      else throw error;
    }
    await this.request(
      exists ? flowPath : '/api/v1/main/flows',
      exists ? 'PUT' : 'POST',
      flow,
      'application/x-yaml',
    );
  }

  /** Start one execution. Inputs are validated identifiers without line breaks. */
  private async execute(id: string, inputs: Record<string, string>) {
    const boundary = `cc-${randomUUID()}`;
    const body =
      Object.entries(inputs)
        .map(
          ([name, value]) =>
            `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        )
        .join('') + `--${boundary}--\r\n`;
    return z
      .object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/) })
      .parse(
        JSON.parse(
          await this.request(
            `/api/v1/main/executions/campus.application/${id}`,
            'POST',
            body,
            `multipart/form-data; boundary=${boundary}`,
          ),
        ),
      ).id;
  }

  async startDeviceSync(input: {
    customerId: string;
    syncId: string;
    correlationId: string;
  }): Promise<string> {
    const values = z
      .strictObject({
        customerId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
        syncId: z.uuid(),
        correlationId: z.uuid(),
      })
      .parse(input);
    await this.deployFlow('device-sync.yaml', 'device_sync');
    return this.execute('device_sync', values);
  }

  async startEntitySync(input: {
    customerId: string;
    jobId: string;
    batchCount: number;
    correlationId: string;
  }): Promise<string> {
    const values = z
      .strictObject({
        customerId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
        jobId: z.uuid(),
        batchCount: z.number().int().min(1).max(1000),
        correlationId: z.uuid(),
      })
      .parse(input);
    await this.deployFlow('entity-sync.yaml', 'entity_sync');
    return this.execute('entity_sync', {
      customerId: values.customerId,
      jobId: values.jobId,
      batches: JSON.stringify(
        Array.from({ length: values.batchCount }, (_, index) => index),
      ),
      correlationId: values.correlationId,
    });
  }

  async check(correlationId: string) {
    await this.deployFlow('phase2-connection.yaml', 'phase2_connection');
    const marker = 'campus-commander-phase-2';
    const execution = {
      id: await this.execute('phase2_connection', { correlationId, marker }),
    };
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const result = z
        .object({
          state: z.object({ current: z.string() }),
          taskRunList: z
            .array(
              z.object({ taskId: z.string(), outputs: z.unknown().optional() }),
            )
            .optional(),
        })
        .parse(
          JSON.parse(
            await this.request(`/api/v1/main/executions/${execution.id}`),
          ),
        );
      if (result.state.current === 'SUCCESS') {
        const outputs = z
          .object({ body: z.string() })
          .parse(
            result.taskRunList?.find((task) => task.taskId === 'dispatch')
              ?.outputs,
          );
        const response = z
          .object({
            status: z.literal('completed'),
            correlationId: z.literal(correlationId),
            executionId: z.literal(execution.id),
            markerSha256: z.string(),
          })
          .parse(JSON.parse(outputs.body));
        const expected = createHash('sha256')
          .update(
            JSON.stringify({
              correlationId,
              executionId: execution.id,
              marker,
            }),
          )
          .digest('hex');
        if (response.markerSha256 !== expected)
          throw new Error('The worker result failed verification.');
        return;
      }
      if (
        ['FAILED', 'KILLED', 'CANCELLED', 'WARNING'].includes(
          result.state.current,
        )
      )
        throw new Error('The synthetic task failed.');
      await setTimeout(500);
    }
    throw new ServiceTimeoutError();
  }
}
