import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import {
  CredentialStore,
  ProofError,
  readPrivateFile,
  writePrivateFile,
} from './store.mjs';
import { DwdProof, sanitizeError, validateServiceAccount } from './dwd.mjs';

const { values } = parseArgs({
  options: {
    config: { type: 'string' },
    action: { type: 'string', default: 'read' },
    'customer-id': { type: 'string' },
  },
});

let proof;
let config;
try {
  config = JSON.parse(await readPrivateFile(values.config));
  if (
    !['stage', 'confirm', 'read'].includes(values.action) ||
    !/^\d+$/.test(config.clientId) ||
    typeof config.subject !== 'string' ||
    ![
      config.credentialStore,
      config.encryptionKey,
      config.privateObservation,
      config.report,
    ].every((path) => typeof path === 'string' && path.startsWith('/')) ||
    new Set(
      [
        config.credentialStore,
        config.encryptionKey,
        config.privateObservation,
        config.report,
        config.serviceAccountFile,
      ].map((path) => path && resolve(path)),
    ).size !== 5
  ) {
    throw new ProofError('invalid-proof-configuration');
  }
  const store = new CredentialStore(
    config.credentialStore,
    config.encryptionKey,
  );
  if (values.action === 'stage') await store.initializeKey();
  const stored = await store.read();
  if (values.action === 'confirm') {
    if (
      !stored ||
      stored.status !== 'awaiting-confirmation' ||
      values['customer-id'] !== stored.customerId
    )
      throw new ProofError('wrong-customer');
    await store.replace(stored.version, { ...stored, status: 'active' });
    process.stdout.write('Customer confirmed.\n');
  } else {
    if (values.action === 'read' && stored?.status !== 'active')
      throw new ProofError('customer-confirmation-required');
    const credential = validateServiceAccount(
      values.action === 'stage'
        ? JSON.parse(await readFile(config.serviceAccountFile, 'utf8'))
        : stored.credential,
      config.clientId,
    );
    proof = new DwdProof({
      credential,
      subject: config.subject,
      orgunits: config.orgunits === true,
      expectedCustomerId: stored?.customerId,
    });
    const result = await proof.run();
    if (values.action === 'stage')
      await store.replace(stored?.version ?? 0, {
        customerId: result.privateObservation.customerId,
        status:
          stored?.status === 'active' ? 'active' : 'awaiting-confirmation',
        credential,
        subject: config.subject,
      });
    await writePrivateFile(
      config.privateObservation,
      JSON.stringify(result.privateObservation, null, 2),
    );
    const library = JSON.parse(
      await readFile(
        new URL(
          '../../node_modules/google-auth-library/package.json',
          import.meta.url,
        ),
      ),
    );
    const report = {
      ...result.report,
      recordedAt: new Date().toISOString(),
      sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim(),
      sourceDirty:
        execFileSync('git', ['status', '--porcelain'], {
          encoding: 'utf8',
        }).trim().length > 0,
      nodeVersion: process.version,
      library: { name: 'google-auth-library', version: library.version },
      action: values.action,
      googleRole: config.googleRole ?? 'not-recorded',
      limits: [
        'Live revocation and same-customer identity replacement require dedicated fixtures.',
        'Domain counts do not prove unavailable secondary or alias fixtures.',
        'Browser consent, OAuth callbacks, and refresh tokens do not apply to DWD.',
        'This proof uses a private file store. Production credentials require PostgreSQL.',
        'This result does not qualify all Phase 3 workflows or deployment profiles.',
      ],
    };
    await writePrivateFile(config.report, JSON.stringify(report, null, 2));
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  }
} catch (error) {
  const failure = {
    profile: 'service-account-dwd',
    ...sanitizeError(error),
    events: proof?.events ?? [],
  };
  // Never serialize provider errors, request objects, tokens, or credential values.
  if (config?.report)
    await writePrivateFile(
      config.report,
      JSON.stringify(failure, null, 2),
    ).catch(() => undefined);
  process.stdout.write(JSON.stringify(failure, null, 2) + '\n');
  process.exitCode = 1;
}
