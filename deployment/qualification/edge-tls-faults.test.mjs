import test from 'node:test';
import assert from 'node:assert/strict';
import { runEdgeTlsFaults } from './edge-tls-faults.mjs';

test('edge TLS faults reject ordinary projects before accessing secrets or Docker', async () => {
  let commands = 0;
  await assert.rejects(
    runEdgeTlsFaults(
      {
        qualificationOnly: true,
        project: 'campus-commander',
        root: '/tmp/cc-installer-fixture',
      },
      { compose: () => commands++ },
    ),
    /disposable installer/,
  );
  assert.equal(commands, 0);
});
