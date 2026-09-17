import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { outerDocker } from './hybrid-hosts-fixture.mjs';
import {
  assertHybridFaultOwnership,
  createHybridFaultStateProbe,
} from './phase3-hybrid-fault-state.mjs';

/** Bind public provider-fault checks to the owned hybrid fixture. */
export function createHybridProviderFaultRuntime(input) {
  assertHybridFaultOwnership(input);
  const { hosts, services, config, verifyWorkflows, verifyReplicas, context } =
    input;
  assert.equal(typeof verifyWorkflows, 'function');
  assert.equal(typeof verifyReplicas, 'function');
  return {
    createDurableProbe: () =>
      createHybridFaultStateProbe({ ...input, allowObservationRefresh: true }),
    async fault(mode) {
      assert.ok(
        [
          '',
          'network',
          'quota',
          'domain-privilege-denied',
          'wrong-customer',
        ].includes(mode),
      );
      for (const host of hosts.hosts) {
        assert.equal(await realpath(host.root), host.root);
        const file = await open(
          join(host.root, 'google-health-fault.json'),
          constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW,
        );
        try {
          await file.writeFile(JSON.stringify({ mode }));
        } finally {
          await file.close();
        }
      }
    },
    ready: () =>
      outerDocker([
        'exec',
        services.database,
        'psql',
        '-U',
        'postgres',
        '-d',
        config.services.applicationDatabase.database,
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        "UPDATE cc.google_health_checks SET retry_at=clock_timestamp()-interval '1 second';",
      ]),
    async verifyRecovery() {
      await verifyWorkflows();
      await verifyReplicas(context);
    },
  };
}
