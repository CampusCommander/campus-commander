import assert from 'node:assert/strict';
import test from 'node:test';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { GoogleConnectionError } from '@campus/google-connection';
import {
  USER_CATEGORY_CACHE_MILLISECONDS,
  UserAttributeCategoriesRoute,
  emptyUserAttributeCategories,
} from './user-attribute-categories.ts';

const at = Date.parse('2026-11-17T12:00:00.000Z');
const hoursAgo = (hours) => new Date(at - hours * 3_600_000).toISOString();

const cached = (overrides = {}) => ({
  categories: [
    {
      schemaId: 'schema-1',
      schemaName: 'StudentInfo',
      displayName: 'Student info',
      etag: 'etag-1',
      fields: [
        {
          fieldId: 'field-1',
          fieldName: 'Homeroom',
          displayName: 'Homeroom',
          fieldType: 'STRING',
          multiValued: false,
          indexed: true,
          readAccessType: 'ADMINS_AND_SELF',
          numericIndexingSpec: null,
          holders: 12,
        },
      ],
      holders: 12,
      readAt: hoursAgo(25),
    },
  ],
  limits: {
    categories: 1,
    categoryLimit: 100,
    attributes: 1,
    attributeLimit: 100,
  },
  observedAt: hoursAgo(25),
  ...overrides,
});

const session = { identity: { id: 'p1', permissionVersion: 1 } };

function fakePort(overrides = {}) {
  const calls = { connection: 0, cached: 0, credential: 0, read: 0, store: [] };
  const port = {
    calls,
    async connection() {
      calls.connection += 1;
      if (overrides.connection !== undefined)
        return typeof overrides.connection === 'function'
          ? overrides.connection()
          : overrides.connection;
      return { customerId: 'C0123456', generation: 4 };
    },
    async cached() {
      calls.cached += 1;
      return overrides.cached === undefined ? cached() : overrides.cached;
    },
    async credential() {
      calls.credential += 1;
      if (overrides.credential !== undefined)
        return typeof overrides.credential === 'function'
          ? overrides.credential()
          : overrides.credential;
      return { token: 'x' };
    },
    async read() {
      calls.read += 1;
      if (overrides.read) return overrides.read();
      return [
        {
          schemaId: 'schema-2',
          schemaName: 'StaffInfo',
          displayName: 'Staff info',
          etag: 'etag-2',
          fields: [
            {
              fieldId: 'field-2',
              fieldName: 'HireDate',
              displayName: 'Hire date',
              fieldType: 'DATE',
              multiValued: false,
              indexed: true,
              readAccessType: 'ALL_DOMAIN_USERS',
              numericIndexingSpec: null,
            },
          ],
        },
      ];
    },
    async store(_session, _customerId, categories, readAt) {
      calls.store.push(readAt);
      return {
        categories: categories.map((category) => ({
          ...category,
          fields: category.fields.map((field) => ({ ...field, holders: 0 })),
          holders: 0,
          readAt,
        })),
        limits: {
          categories: 1,
          categoryLimit: 100,
          attributes: 1,
          attributeLimit: 100,
        },
        observedAt: readAt,
      };
    },
  };
  return port;
}

const route = (port) =>
  new UserAttributeCategoriesRoute(port, { now: () => at });

test('a cache younger than a day answers alone', async () => {
  const port = fakePort({ cached: cached({ observedAt: hoursAgo(1) }) });
  const read = await route(port).read(session);
  assert.equal(read.categories[0].schemaName, 'StudentInfo');
  assert.equal(port.calls.read, 0);
  assert.equal(port.calls.connection, 0);
});

test('an empty set younger than a day answers alone', async () => {
  // The SQL writer keeps the observation time of an empty snapshot, so the class reads it as
  // current and never calls Google (R2).
  const port = fakePort({
    cached: cached({
      categories: [],
      limits: {
        categories: 0,
        categoryLimit: 100,
        attributes: 0,
        attributeLimit: 100,
      },
      observedAt: hoursAgo(1),
    }),
  });
  const read = await route(port).read(session);
  assert.deepEqual(read.categories, []);
  assert.equal(port.calls.read, 0);
  assert.equal(port.calls.connection, 0);
});

test('a cache at the day boundary reads Google again', async () => {
  const port = fakePort({
    cached: cached({
      observedAt: new Date(at - USER_CATEGORY_CACHE_MILLISECONDS).toISOString(),
    }),
  });
  const read = await route(port).read(session);
  assert.equal(port.calls.read, 1);
  assert.equal(read.categories[0].schemaName, 'StaffInfo');
});

test('a stale cache stores the fresh read with its read time', async () => {
  const port = fakePort();
  const read = await route(port).read(session);
  assert.deepEqual(port.calls.store, [new Date(at).toISOString()]);
  assert.equal(read.observedAt, new Date(at).toISOString());
  assert.equal(read.categories[0].schemaName, 'StaffInfo');
});

test('a failed Google read keeps the stale cache', async () => {
  const port = fakePort({
    cached: cached(),
    read: () => {
      throw new GoogleConnectionError('quota');
    },
  });
  const read = await route(port).read(session);
  assert.equal(read.categories[0].schemaName, 'StudentInfo');
  assert.equal(port.calls.store.length, 0);
});

test('an empty cache and a failed read answer the failure', async () => {
  const port = fakePort({
    cached: emptyUserAttributeCategories(),
    read: () => {
      throw new GoogleConnectionError('scope-mismatch');
    },
  });
  await assert.rejects(route(port).read(session), (error) => {
    assert.equal(error instanceof ServiceUnavailableException, true);
    assert.deepEqual(error.getResponse(), {
      reason: 'user-schema-read-failed',
      failure: 'scope-mismatch',
    });
    return true;
  });
});

test('a customer without a connection reads no category', async () => {
  const port = fakePort({ cached: null });
  const read = await route(port).read(session);
  assert.deepEqual(read, emptyUserAttributeCategories());
  assert.equal(port.calls.read, 0);
});

test('refresh reads Google without the cache', async () => {
  const port = fakePort();
  const read = await route(port).refresh(session);
  assert.equal(port.calls.cached, 0);
  assert.equal(port.calls.credential, 1);
  assert.equal(read.categories[0].schemaName, 'StaffInfo');
});

test('refresh without a connection answers connection-required', async () => {
  const port = fakePort({ connection: null });
  await assert.rejects(route(port).refresh(session), (error) => {
    assert.equal(error.getStatus(), 409);
    assert.deepEqual(error.getResponse(), { reason: 'connection-required' });
    return true;
  });
});

test('refresh with a closed credential answers connection-required', async () => {
  const port = fakePort({ credential: null });
  await assert.rejects(route(port).refresh(session), (error) => {
    assert.equal(error.getStatus(), 409);
    return true;
  });
});

test('a refresh maps a Google failure to its code', async () => {
  const port = fakePort({
    read: () => {
      throw new GoogleConnectionError('permission-denied');
    },
  });
  await assert.rejects(route(port).refresh(session), (error) => {
    assert.equal(error instanceof ServiceUnavailableException, true);
    assert.deepEqual(error.getResponse(), {
      reason: 'user-schema-read-failed',
      failure: 'permission-denied',
    });
    return true;
  });
});

test('the empty set carries both account limits', () => {
  const empty = emptyUserAttributeCategories();
  assert.equal(empty.categories.length, 0);
  assert.equal(empty.limits.categoryLimit, 100);
  assert.equal(empty.limits.attributeLimit, 100);
  assert.equal(empty.observedAt, null);
});

test('a moved credential with no cache answers the conflict, not a read failure', async () => {
  const port = fakePort({
    cached: emptyUserAttributeCategories(),
    credential: () => {
      throw new ConflictException({ reason: 'credential-changed' });
    },
  });
  await assert.rejects(route(port).read(session), (error) => {
    assert.equal(error.getStatus(), 409);
    assert.deepEqual(error.getResponse(), { reason: 'credential-changed' });
    return true;
  });
});
