import assert from 'node:assert/strict';
import test from 'node:test';
import { GOOGLE_SETUP_SCOPES } from './google-capabilities.ts';
import {
  buildDelegationLink,
  delegationLink,
  delegationLinkScopes,
} from './google-delegation-link.ts';

const CONSOLE = 'https://admin.google.com/ac/owl/domainwidedelegation';
const CUSTOMER =
  'https://www.googleapis.com/auth/admin.directory.customer.readonly';
const DOMAIN =
  'https://www.googleapis.com/auth/admin.directory.domain.readonly';
const INVENTORY =
  'https://www.googleapis.com/auth/admin.directory.device.chromeos.readonly';
const TELEMETRY =
  'https://www.googleapis.com/auth/chrome.management.telemetry.readonly';
const SCHOOL_OU =
  'https://www.googleapis.com/auth/admin.directory.orgunit.readonly';
const DRIVE = 'https://www.googleapis.com/auth/drive.file';

test('the delegation link holds the sorted scopes, the client ID, and the replace flag', () => {
  assert.equal(
    delegationLink({ clientId: '123456789', scopes: [DOMAIN, CUSTOMER] }),
    `${CONSOLE}?clientScopeToAdd=${CUSTOMER},${DOMAIN}&clientIdToAdd=123456789&overwriteClientId=true`,
  );
});

test('the delegation link adds the primary domain only when the page knows it', () => {
  assert.equal(
    delegationLink({
      clientId: '123456789',
      scopes: [CUSTOMER],
      domain: 'example.org',
    }),
    `${CONSOLE}?clientScopeToAdd=${CUSTOMER}&clientIdToAdd=123456789&overwriteClientId=true&dn=example.org`,
  );
  assert.equal(
    delegationLink({ clientId: '123456789', scopes: [CUSTOMER] }),
    `${CONSOLE}?clientScopeToAdd=${CUSTOMER}&clientIdToAdd=123456789&overwriteClientId=true`,
  );
});

test('the delegation link omits authuser and the delegated subject', () => {
  const link = delegationLink({
    clientId: '123456789',
    scopes: [CUSTOMER],
    domain: 'example.org',
  });
  assert.equal(
    link,
    `${CONSOLE}?clientScopeToAdd=${CUSTOMER}&clientIdToAdd=123456789&overwriteClientId=true&dn=example.org`,
  );
  assert.ok(!link.includes('authuser'));
  assert.ok(!link.includes('@'));
});

test('the delegation link rejects a client ID that is not all digits', () => {
  for (const clientId of ['', '12345678a', '123-456', ' 123456789']) {
    assert.throws(() => delegationLink({ clientId, scopes: [CUSTOMER] }));
  }
});

test('the delegation link rejects an empty scope list', () => {
  assert.throws(() => delegationLink({ clientId: '123456789', scopes: [] }));
});

test('the delegation link rejects a scope that no capability names', () => {
  assert.throws(() =>
    delegationLink({
      clientId: '123456789',
      scopes: ['https://www.googleapis.com/auth/unknown.readonly'],
    }),
  );
});

test('the delegation scopes hold the sorted union without duplicates', () => {
  assert.deepEqual(
    delegationLinkScopes([DOMAIN, CUSTOMER], [CUSTOMER, INVENTORY]),
    [CUSTOMER, INVENTORY, DOMAIN],
  );
  assert.deepEqual(delegationLinkScopes([], []), []);
  assert.deepEqual(delegationLinkScopes([TELEMETRY, SCHOOL_OU], []), [
    SCHOOL_OU,
    TELEMETRY,
  ]);
});

test('the delegation link lists the seven setup scopes in sorted order', () => {
  const listed = new URL(
    delegationLink({ clientId: '123456789', scopes: GOOGLE_SETUP_SCOPES }),
  ).searchParams
    .get('clientScopeToAdd')
    .split(',');
  assert.equal(listed.length, 7);
  assert.deepEqual(listed, [...GOOGLE_SETUP_SCOPES].sort());
  assert.ok(listed.includes(DRIVE), 'The link lists the Drive scope.');
});

test('the shared link helper lists the requested and verified scopes once', () => {
  assert.equal(
    buildDelegationLink({
      clientId: '123456789',
      requested: [DOMAIN, CUSTOMER],
      verified: [SCHOOL_OU, CUSTOMER],
      domain: 'example.org',
    }),
    `${CONSOLE}?clientScopeToAdd=${CUSTOMER},${DOMAIN},${SCHOOL_OU}&clientIdToAdd=123456789&overwriteClientId=true&dn=example.org`,
  );
  assert.equal(
    buildDelegationLink({ clientId: '123456789', requested: [CUSTOMER] }),
    `${CONSOLE}?clientScopeToAdd=${CUSTOMER}&clientIdToAdd=123456789&overwriteClientId=true`,
  );
});

test('the shared link helper returns null without a usable client ID', () => {
  for (const clientId of ['', ' 123456789', '12345678a', '1'.repeat(33)])
    assert.equal(
      buildDelegationLink({ clientId, requested: [CUSTOMER] }),
      null,
    );
  assert.equal(
    buildDelegationLink({ clientId: '123456789', requested: [] }),
    null,
  );
});
