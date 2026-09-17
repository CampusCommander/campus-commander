import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Exercise the production CLI after actual restore with controlled Google transport responses. */
export async function qualifyGoogleRevalidationCli({
  operatorCli,
  directory,
  targetDirectory,
  targetConfig,
  applicationCredentials,
  recovery,
  connect,
  setKeyFault,
}) {
  const input = { targetDirectory, targetConfig, applicationCredentials };
  const withDatabase = async (action) => {
    const client = await connect();
    try {
      return await action(client);
    } finally {
      await client.end();
    }
  };
  const snapshot = () =>
    withDatabase(async (client) => {
      const { rows } = await client.query(`
      SELECT 'gate' AS relation,md5(row_to_json(t)::text) AS state FROM cc.google_restore_gate t
      UNION ALL SELECT 'connection',md5(row_to_json(t)::text) FROM cc.google_connection t
      UNION ALL SELECT 'credential',md5(row_to_json(t)::text) FROM cc.google_credentials t
      UNION ALL SELECT 'event',md5(row_to_json(t)::text) FROM cc.security_events t
      ORDER BY relation,state`);
      return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    });
  const faultPath = join(directory, 'google-health-fault.json');
  const setProviderFault = (mode) =>
    writeFile(faultPath, JSON.stringify({ mode }), { mode: 0o600 });
  const receiptPath = join(targetDirectory, 'google-revalidation.json');
  const markerPath = join(targetDirectory, 'RESTORE_DISABLED');
  const marker = await readFile(markerPath, 'utf8');
  const before = await snapshot();
  const failures = [];
  const rejected = async (caseName, reason) => {
    await assert.rejects(
      operatorCli.run('revalidate-google', input),
      (error) => {
        assert.equal(error.code, 1);
        assert.equal(error.stdout, '');
        assert.ok(error.stderr.includes(`Reason: ${reason}.`));
        assert.ok(
          !error.stderr.includes('synthetic-private-provider-diagnostic'),
        );
        assert.ok(!error.stderr.includes(targetDirectory));
        return true;
      },
    );
    assert.equal(await snapshot(), before);
    assert.equal(await readFile(markerPath, 'utf8'), marker);
    await assert.rejects(readFile(receiptPath), { code: 'ENOENT' });
    failures.push({ case: caseName, reason, unchanged: true });
  };
  try {
    setKeyFault('missing');
    await rejected('missing-google-key', 'RESTORE_GOOGLE_KEY_MISSING');
    setKeyFault('backup-key');
    await rejected(
      'backup-key-for-google-credential',
      'RESTORE_GOOGLE_KEY_INVALID',
    );
    setKeyFault('none');
    for (const [mode, reason] of [
      ['domain-delegation-denied', 'GOOGLE_DELEGATION_DENIED'],
      ['domain-privilege-denied', 'GOOGLE_PERMISSION_DENIED'],
      ['wrong-customer', 'RESTORE_GOOGLE_CUSTOMER_MISMATCH'],
    ]) {
      await setProviderFault(mode);
      await rejected(mode, reason);
    }
    await setProviderFault('');
    const active = await connect();
    try {
      await rejected(
        'active-database-connection',
        'DATABASE_CONNECTIONS_ACTIVE',
      );
    } finally {
      await active.end();
    }
    await withDatabase((client) =>
      client.query(
        "ALTER TABLE cc.security_events ADD CONSTRAINT restore_cli_audit_failure CHECK(detail IS DISTINCT FROM 'restore-revalidated') NOT VALID",
      ),
    );
    try {
      await rejected('audit-insert-failure', 'UNCLASSIFIED_FAILURE');
    } finally {
      await withDatabase((client) =>
        client.query(
          'ALTER TABLE cc.security_events DROP CONSTRAINT restore_cli_audit_failure',
        ),
      );
    }
    const { result } = await operatorCli.run('revalidate-google', input);
    assert.equal(result.status, 'revalidated');
    assert.equal(result.recoveryId, recovery.recoveryId);
    assert.equal(result.customerId, recovery.customerId);
    assert.equal(result.generation, recovery.generation);
    assert.deepEqual(JSON.parse(await readFile(receiptPath, 'utf8')), result);
    assert.equal((await stat(receiptPath)).mode & 0o077, 0);
    assert.equal(await readFile(markerPath, 'utf8'), marker);
    await withDatabase(async (client) => {
      assert.ok(
        (await client.query('SELECT verified_at FROM cc.google_restore_gate'))
          .rows[0].verified_at,
      );
      assert.equal(
        (
          await client.query(
            'SELECT cc.acquire_google_access($1,$2,$3) AS result',
            [recovery.customerId, recovery.generation, randomUUID()],
          )
        ).rows[0].result.status,
        'renew',
      );
      assert.equal(
        (
          await client.query(
            "SELECT count(*)::int AS count FROM cc.security_events WHERE detail='restore-revalidated' AND correlation_id=$1",
            [recovery.recoveryId],
          )
        ).rows[0].count,
        1,
      );
    });
    const verified = await snapshot();
    await rm(receiptPath);
    await mkdir(receiptPath, { mode: 0o700 });
    try {
      await assert.rejects(
        operatorCli.run('revalidate-google', input),
        (error) => {
          assert.equal(error.code, 1);
          assert.equal(error.stdout, '');
          assert.ok(error.stderr.includes('Reason: UNCLASSIFIED_FAILURE.'));
          assert.ok(!error.stderr.includes(targetDirectory));
          return true;
        },
      );
      assert.equal(await snapshot(), verified);
      assert.equal(await readFile(markerPath, 'utf8'), marker);
    } finally {
      await rm(receiptPath, { recursive: true });
    }
    await setProviderFault('wrong-customer');
    const repeated = (await operatorCli.run('revalidate-google', input)).result;
    assert.deepEqual(repeated, { ...result, status: 'already-revalidated' });
    assert.equal(await snapshot(), verified);
    assert.deepEqual(JSON.parse(await readFile(receiptPath, 'utf8')), repeated);
    assert.equal((await stat(receiptPath)).mode & 0o077, 0);
    assert.equal(await readFile(markerPath, 'utf8'), marker);
    return {
      exactRecoveredKeyVerified: true,
      backupKeyCannotDecryptGoogleCredential: true,
      wrongCustomerRejected: true,
      missingKeyRejected: true,
      revalidation: result,
      repeatedReceiptPreserved: true,
      receiptWriteFailureRecovered: true,
      serviceDisableMarkerPreserved: true,
      failures,
      provider:
        'production Google verifier and SDK with synthetic Gaxios transport',
      limits: [
        'The fixture uses synthetic Google responses. Live grant and privilege qualification remain separate.',
      ],
    };
  } finally {
    setKeyFault('none');
    await setProviderFault('');
  }
}
