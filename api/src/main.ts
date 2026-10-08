import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import 'pg';
import 'zod';
import { AppModule } from './app/app.module';
import { ApplicationExceptionFilter, securityHeaders } from './app/security';
import type {
  StartupRuntime,
  StartupRuntimeModule,
} from './app/startup-runtime.contract';

async function bootstrap() {
  const runtime = await createRuntime();
  const certificatePath = process.env.TLS_CERT_FILE;
  const keyPath = process.env.TLS_KEY_FILE;
  if ((certificatePath || keyPath) && !(certificatePath && keyPath)) {
    throw new Error(
      'TLS certificate and key files must be configured together.',
    );
  }
  const httpsOptions =
    certificatePath && keyPath
      ? {
          cert: readFileSync(certificatePath),
          key: readFileSync(keyPath),
        }
      : undefined;
  const app = await NestFactory.create(
    AppModule.register(runtime),
    httpsOptions ? { httpsOptions } : undefined,
  );
  app.enableShutdownHooks(['SIGINT', 'SIGTERM']);
  app.use(securityHeaders);
  app.useGlobalFilters(new ApplicationExceptionFilter());
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  Logger.log(
    `API listening with ${certificatePath ? 'HTTPS' : 'HTTP'} on port ${port}`,
  );
}

async function createRuntime(): Promise<StartupRuntime | undefined> {
  const configPath = process.env.CC_CONFIG_FILE;
  if (!configPath) return undefined;
  const moduleUrl = pathToFileURL(
    resolve(process.cwd(), 'deployment/bootstrap/api-runtime.mjs'),
  ).href;
  const runtimeModule = (await import(
    /* webpackIgnore: true */ moduleUrl
  )) as StartupRuntimeModule;
  return runtimeModule.createStartupRuntime(configPath);
}

void bootstrap().catch(() => {
  Logger.error('API startup failed');
  process.exitCode = 1;
});
