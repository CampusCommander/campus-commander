import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import { createAllDockerDurableProbe } from './all-docker-faults-fixture.mjs';

/** Qualify provider failures without changing the installed customer or local authority. */
export async function qualifyInstalledProviderFaults({
  root,
  project,
  config,
  release,
  compose,
  id,
  page,
  checks,
  evidencePath,
  evidenceIdentity,
  runtime,
}) {
  const startedAt = Date.now();
  const report = {
    ...evidenceIdentity,
    schemaVersion: 1,
    phase: 3,
    profile: config.profile,
    status: 'in-progress',
    sourceRevision: release.sourceRevision,
    images: release.images,
    recordedAt: new Date().toISOString(),
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      browser: page.context().browser().version(),
    },
    durationScope:
      'Provider fault setup, public checks, local sign-in, recovery, and preservation probes.',
    recoveryBoundSeconds: 45,
    cases: [],
    limits: [
      'Google responses and application sign-in use independent synthetic providers.',
      'The fixture advances the health-check retry timestamp in its owned database.',
      'Policy hashes exclude connection observation fields that successful health checks refresh. Each failed check separately preserves the full connection.',
      'These checks do not establish live Google privileges, revocation, or Education behavior.',
      'Capacity, certificates, and complete profile acceptance require separate evidence.',
    ],
  };
  const save = async () => {
    report.durationMs = Date.now() - startedAt;
    await writeFile(evidencePath, JSON.stringify(report, null, 2) + '\n', {
      mode: 0o600,
    });
  };
  const fault =
    runtime?.fault ??
    ((mode) =>
      writeFile(
        join(root, 'google-health-fault.json'),
        JSON.stringify({ mode }),
        { mode: 0o644 },
      ));
  const request = async (
    path,
    data,
    status = data === undefined ? 200 : 201,
  ) => {
    const result = await page.evaluate(
      async ({ path, data }) => {
        const options = { signal: AbortSignal.timeout(45000) };
        if (data !== undefined) {
          const session = await (await fetch('/api/auth/session')).json();
          Object.assign(options, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-csrf-token': session.csrfToken,
            },
            body: JSON.stringify(data),
          });
        }
        const response = await fetch(path, options);
        return { status: response.status, body: await response.json() };
      },
      { path, data },
    );
    assert.equal(
      result.status,
      status,
      'The installed provider check returned an unexpected status.',
    );
    return result.body;
  };
  const connectionPath = '/api/google-connection';
  const ready =
    runtime?.ready ??
    (() =>
      execFileSync(
        'docker',
        [
          'exec',
          id('application-postgres'),
          'psql',
          '-U',
          'postgres',
          '-d',
          config.services.applicationDatabase.database,
          '-v',
          'ON_ERROR_STOP=1',
          '-c',
          "UPDATE cc.google_health_checks SET retry_at=clock_timestamp()-interval '1 second';",
        ],
        { stdio: 'pipe', timeout: 15000 },
      ));
  let ownsFixture = false;
  try {
    await save();
    if (config.profile === 'hybrid')
      for (const method of [
        'createDurableProbe',
        'fault',
        'ready',
        'verifyRecovery',
      ])
        assert.equal(typeof runtime?.[method], 'function');
    const verifyDurable = runtime
      ? await runtime.createDurableProbe()
      : await createAllDockerDurableProbe({
          root,
          project,
          config,
          release,
          compose,
          id,
          allowObservationRefresh: true,
        });
    ownsFixture = true;
    const connection = (await request(connectionPath)).connection;
    assert.equal(connection.generation, 2);
    const input = {
      customerId: connection.customerId,
      generation: connection.generation,
      capabilities: ['customer-identity', 'domain-observations'],
    };
    const check = async (data = input, status = 201) => {
      await ready();
      return (await request(`${connectionPath}/health/check`, data, status))
        .health;
    };
    const baseline = await check();
    assert.ok(baseline.capabilities.every((item) => item.failure === null));
    await ready();
    const retired = await request(
      `${connectionPath}/health/check`,
      { ...input, generation: input.generation - 1 },
      409,
    );
    assert.equal(retired.reason, 'credential-changed');
    report.retiredGenerationRejected = true;
    for (const [mode, failure, capability] of [
      ['network', 'network-failure', 'domain-observations'],
      ['quota', 'quota', 'domain-observations'],
      ['domain-privilege-denied', 'permission-denied', 'domain-observations'],
      ['wrong-customer', 'wrong-customer', 'customer-identity'],
    ]) {
      const record = { name: mode, status: 'in-progress' };
      report.cases.push(record);
      await save();
      const before = (await request(`${connectionPath}/health`)).health;
      const beforeConnection = (await request(connectionPath)).connection;
      const beforeCustomer = (await request('/api/customer')).customer;
      const caseStartedAt = Date.now();
      try {
        await fault(mode);
        const failed = await check();
        const observation = failed.capabilities.find(
          (item) => item.capability === capability,
        );
        assert.ok(observation, 'The failed capability must remain visible.');
        assert.equal(observation.failure, failure);
        assert.equal(
          observation.lastSucceededAt,
          before.capabilities.find((item) => item.capability === capability)
            .lastSucceededAt,
        );
        record.failure = observation.failure;
        record.lastSuccessPreserved = true;
        await request('/api/auth/session');
        await checks();
        record.localDiagnosticsPassed = true;
        if (mode === 'network') {
          const context = await page
            .context()
            .browser()
            .newContext({ ignoreHTTPSErrors: true });
          try {
            const login = await context.newPage();
            await login.goto(config.applicationAuth.publicOrigin + '/login');
            await login
              .getByRole('link', { name: 'Sign in to Campus Commander' })
              .click();
            await expect(
              login.getByRole('heading', { name: 'Your account', exact: true }),
            ).toBeVisible({ timeout: 15000 });
            record.freshSignInPassed = true;
          } catch {
            throw new Error(
              'Local sign-in failed during the synthetic Google outage.',
            );
          } finally {
            await context.close();
          }
        }
        assert.deepEqual(
          (await request(connectionPath)).connection,
          beforeConnection,
        );
        record.connectionPreserved = true;
        assert.deepEqual(
          (await request('/api/customer')).customer,
          beforeCustomer,
        );
        record.durableState = await verifyDurable();
      } finally {
        await fault('');
      }
      const recoveryStartedAt = Date.now();
      const recovered = await check();
      assert.ok(recovered.capabilities.every((item) => item.failure === null));
      record.durableState = await verifyDurable();
      await runtime?.verifyRecovery();
      record.recoveryMs = Date.now() - recoveryStartedAt;
      assert.ok(record.recoveryMs <= report.recoveryBoundSeconds * 1000);
      record.recovered = true;
      record.durationMs = Date.now() - caseStartedAt;
      record.status = 'passed';
      await save();
    }
    report.status = 'passed';
    await save();
    return report;
  } catch (error) {
    report.status = 'failed';
    if (report.cases.at(-1)?.status === 'in-progress')
      report.cases.at(-1).status = 'failed';
    await save();
    throw error;
  } finally {
    if (ownsFixture) await fault('');
  }
}
