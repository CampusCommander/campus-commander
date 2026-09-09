import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { checkServerIdentity } from 'node:tls';
import pg from 'pg';
import { normalizePostgresSecret } from './secrets.mjs';

export const POSTGRES_VERSION = '18.6';
const LOCK = '7240173007';
const identifier = (value) => {
  if (!/^[a-z][a-z0-9_-]{0,62}$/.test(value))
    throw new Error('Invalid database identifier.');
  return `"${value}"`;
};
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;

export async function connectionOptions(service, resolveSecret) {
  const url = new URL(service.endpoint.url);
  if (
    url.protocol !== 'postgresql:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['', '/'].includes(url.pathname)
  ) {
    throw new Error(
      'Use a PostgreSQL origin without credentials, paths, or query parameters.',
    );
  }
  const mode = service.endpoint.tls.mode;
  if (!['disabled', 'system-ca', 'private-ca'].includes(mode))
    throw new Error('Invalid TLS mode.');
  if (service.placement.kind === 'external' && mode === 'disabled')
    throw new Error('External PostgreSQL requires verified TLS.');
  const ssl =
    mode === 'disabled'
      ? false
      : {
          rejectUnauthorized: true,
          checkServerIdentity: (_hostname, certificate) =>
            checkServerIdentity(url.hostname, certificate),
          ...(mode === 'private-ca'
            ? { ca: await resolveSecret(service.endpoint.tls.caSecretRef) }
            : {}),
        };
  return {
    host: url.hostname,
    port: Number(url.port || 5432),
    database: service.database,
    user: service.role,
    password: normalizePostgresSecret(
      await resolveSecret(service.passwordSecretRef),
    ),
    ssl,
    connectionTimeoutMillis: 5000,
    statement_timeout: 60000,
    application_name: 'campus-commander',
  };
}

export async function connectDatabase(service, resolveSecret) {
  const client = new pg.Client(await connectionOptions(service, resolveSecret));
  try {
    await client.connect();
    await verifyConnection(client);
    return client;
  } catch {
    await client.end().catch(() => undefined);
    throw new Error('PostgreSQL connection verification failed.');
  }
}

export async function verifyConnection(client) {
  const {
    rows: [row],
  } =
    await client.query(`SELECT current_setting('server_version_num') AS version,
    current_setting('server_encoding') AS encoding, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
    FROM pg_roles WHERE rolname = current_user`);
  if (row.version !== '180006')
    throw new Error('PostgreSQL release does not match the qualified version.');
  if (row.encoding !== 'UTF8')
    throw new Error('PostgreSQL requires UTF8 encoding.');
  if (
    row.rolsuper ||
    row.rolcreatedb ||
    row.rolcreaterole ||
    row.rolreplication ||
    row.rolbypassrls
  ) {
    throw new Error(
      'Runtime database roles must not have cluster administration privileges.',
    );
  }
}

export async function loadMigrations() {
  const sql = await readFile(
    new URL('./migrations/001-foundation.sql', import.meta.url),
    'utf8',
  );
  return [
    {
      id: '001-foundation',
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    },
  ];
}

export async function migrate(client, { runtimeRole, migrations } = {}) {
  if (!runtimeRole)
    throw new Error('The application runtime role is required.');
  const role = identifier(runtimeRole);
  migrations ??= await loadMigrations();
  await verifyConnection(client);
  await client.query('SELECT pg_advisory_lock($1::bigint)', [LOCK]);
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS cc;
      REVOKE ALL ON SCHEMA public FROM PUBLIC;
      REVOKE ALL ON SCHEMA cc FROM PUBLIC;
      CREATE TABLE IF NOT EXISTS cc.schema_migrations (
        id text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
      );
      GRANT USAGE ON SCHEMA cc TO ${role};
      GRANT SELECT ON cc.schema_migrations TO ${role}`);
    for (const migration of migrations) {
      const { rows } = await client.query(
        'SELECT checksum FROM cc.schema_migrations WHERE id = $1',
        [migration.id],
      );
      if (rows.length) {
        if (rows[0].checksum !== migration.checksum)
          throw new Error(
            'Applied migration checksum differs from the release.',
          );
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO cc.schema_migrations(id, checksum) VALUES ($1, $2)',
          [migration.id, migration.checksum],
        );
        await client.query('COMMIT');
      } catch {
        await client.query('ROLLBACK');
        throw new Error(
          'Application migration failed. Dependent services must remain unready.',
        );
      }
    }
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON cc.artifacts, cc.bootstrap_access TO ${role}`,
    );
  } finally {
    await client.query('SELECT pg_advisory_unlock($1::bigint)', [LOCK]);
  }
}

export async function checkReadiness(client, migrations) {
  try {
    await verifyConnection(client);
    migrations ??= await loadMigrations();
    const { rows } = await client.query(
      'SELECT id, checksum FROM cc.schema_migrations ORDER BY id',
    );
    return (
      rows.length === migrations.length &&
      migrations.every((migration) =>
        rows.some(
          (row) =>
            row.id === migration.id && row.checksum === migration.checksum,
        ),
      )
    );
  } catch {
    return false;
  }
}

// Only the installation operator calls this function with cluster administration credentials.
export async function provision(
  client,
  { application, kestra, only = 'both' },
) {
  if (!['both', 'application', 'kestra'].includes(only))
    throw new Error('Invalid provisioning scope.');
  const roles = [application.role, application.migrationRole, kestra.role];
  if (new Set(roles).size !== 3 || application.database === kestra.database) {
    throw new Error(
      'Application, migrator, and Kestra require distinct roles and databases.',
    );
  }
  roles.forEach(identifier);
  [application.database, kestra.database].forEach(identifier);
  await client.query('SET standard_conforming_strings = on');
  await client.query('SELECT pg_advisory_lock($1::bigint)', [LOCK]);
  try {
    const roleSettings = [
      ...(only !== 'kestra'
        ? [
            [application.role, application.password],
            [application.migrationRole, application.migrationPassword],
          ]
        : []),
      ...(only !== 'application' ? [[kestra.role, kestra.password]] : []),
    ];
    for (const [role, password] of roleSettings) {
      if (
        typeof password !== 'string' ||
        password.length < 16 ||
        password.includes('\0')
      )
        throw new Error('Database passwords require at least 16 characters.');
      const existing = await client.query(
        'SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1',
        [role],
      );
      if (existing.rows.some((row) => Object.values(row).some(Boolean)))
        throw new Error('Refusing to reuse an administration role.');
      if (!existing.rowCount)
        await client.query(`CREATE ROLE ${identifier(role)} LOGIN`);
      const memberships = await client.query(
        'SELECT 1 FROM pg_auth_members WHERE member = (SELECT oid FROM pg_roles WHERE rolname = $1)',
        [role],
      );
      if (memberships.rowCount)
        throw new Error('Database roles must not inherit other roles.');
      await client.query(
        `ALTER ROLE ${identifier(role)} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${literal(password)}`,
      );
    }
    const databases = [
      ...(only !== 'kestra'
        ? [[application.database, application.migrationRole, application.role]]
        : []),
      ...(only !== 'application'
        ? [[kestra.database, kestra.role, kestra.role]]
        : []),
    ];
    for (const [database, owner, runtime] of databases) {
      const existing = await client.query(
        'SELECT pg_get_userbyid(datdba) AS owner, pg_encoding_to_char(encoding) AS encoding FROM pg_database WHERE datname = $1',
        [database],
      );
      if (!existing.rowCount) {
        await client.query(
          `CREATE DATABASE ${identifier(database)} OWNER ${identifier(owner)} ENCODING 'UTF8' TEMPLATE template0`,
        );
      } else if (
        existing.rows[0].owner !== owner ||
        existing.rows[0].encoding !== 'UTF8'
      ) {
        throw new Error(
          'Existing database ownership or encoding differs from the installation contract.',
        );
      }
      await client.query(`REVOKE ALL ON DATABASE ${identifier(database)} FROM PUBLIC;
        GRANT CONNECT ON DATABASE ${identifier(database)} TO ${identifier(runtime)}`);
      const otherRoles = await client.query(
        'SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])',
        [roles.filter((role) => role !== owner && role !== runtime)],
      );
      if (otherRoles.rowCount)
        await client.query(
          `REVOKE ALL ON DATABASE ${identifier(database)} FROM ${otherRoles.rows.map((row) => identifier(row.rolname)).join(', ')}`,
        );
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1::bigint)', [LOCK]);
  }
}
