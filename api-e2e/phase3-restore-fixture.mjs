import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { expect } from '@playwright/test';
import { connectionOptions } from '../deployment/postgres/index.mjs';
import {
  seedPhase3State,
  verifyPhase3State,
} from '../deployment/operations/phase3-state-fixture.mjs';

async function withDatabase(config, resolveSecret, credentials, run) {
  const client = new pg.Client(
    await connectionOptions(
      { ...config.services.applicationDatabase, ...credentials },
      resolveSecret,
    ),
  );
  try {
    await client.connect();
    return await run(client);
  } finally {
    await client.end();
  }
}

/** Seed customer state after the source application stops. */
export async function seedApplicationPhase3({
  config,
  resolveSecret,
  applicationCredentials,
  before,
}) {
  return withDatabase(
    config,
    resolveSecret,
    applicationCredentials,
    async (client) => {
      const principal = before.principals[0];
      const source = await seedPhase3State(
        client,
        principal.id,
        principal.permission_version,
        {
          key: await resolveSecret(
            config.googleConnection.encryptionKeySecretRef,
          ),
          keyId: config.googleConnection.keyId,
        },
      );
      before.events = JSON.parse(
        JSON.stringify(
          (await client.query('SELECT * FROM cc.security_events ORDER BY id'))
            .rows,
        ),
      );
      return source;
    },
  );
}

/** Verify durable state and revalidate the credential before target startup. */
export async function verifyApplicationPhase3({
  config,
  resolveSecret,
  applicationCredentials,
  source,
  restoration,
  operatorCli,
  targetDirectory,
}) {
  const state = await withDatabase(
    config,
    resolveSecret,
    applicationCredentials,
    (migration) =>
      withDatabase(config, resolveSecret, {}, (runtime) =>
        verifyPhase3State(
          migration,
          runtime,
          source,
          restoration.accessRecovery,
          undefined,
          {
            deferRevalidation: true,
          },
        ),
      ),
  );
  const marker = await readFile(join(targetDirectory, 'RESTORE_DISABLED'));
  const { result } = await operatorCli.run('revalidate-google', {
    targetConfig: config,
    targetDirectory,
    applicationCredentials,
  });
  assert.equal(result.status, 'revalidated');
  assert.equal(result.customerId, source.customerId);
  assert.equal(result.generation, 1);
  assert.deepEqual(
    await readFile(join(targetDirectory, 'RESTORE_DISABLED')),
    marker,
  );
  return {
    ...state,
    status: 'passed',
    revalidation: result,
    markerPreserved: true,
    provider: 'synthetic-gaxios-preload',
  };
}

/** Read restored customer settings and school scope through a fresh browser session. */
export async function readApplicationPhase3(page, publicOrigin, source) {
  const read = (path) =>
    page.evaluate(async (url) => {
      const response = await fetch(url);
      return { status: response.status, body: await response.json() };
    }, path);
  const customerResponse = await read('/api/customer');
  assert.equal(customerResponse.status, 200);
  const { customer } = customerResponse.body;
  assert.equal(customer.customerId, source.customerId);
  assert.equal(customer.settings.displayName, 'École Restore 学校');
  const schoolResponse = await read(`/api/schools/${source.schoolId}`);
  assert.equal(schoolResponse.status, 200);
  const school = schoolResponse.body;
  assert.equal(school.id, source.schoolId);
  assert.deepEqual(school.approvedIds, ['school']);
  assert.equal(school.effectiveIds, null);
  await page.goto(`${publicOrigin}/schools`);
  await expect(
    page.getByRole('button', { name: 'École Restore', exact: true }),
  ).toBeVisible();
  return {
    customerSettingsRead: true,
    schoolDefinitionRead: true,
    oldReferencesEffective: false,
  };
}
