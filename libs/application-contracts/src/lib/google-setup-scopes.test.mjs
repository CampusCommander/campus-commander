import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GOOGLE_CUSTOMER_SCOPES,
  GOOGLE_SETUP_SCOPES,
} from './google-capabilities.ts';

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

test('the setup scope list holds the connection scopes and the device scopes in order', () => {
  assert.deepEqual(GOOGLE_SETUP_SCOPES, [
    CUSTOMER,
    DOMAIN,
    INVENTORY,
    TELEMETRY,
  ]);
  assert.equal(
    new Set(GOOGLE_SETUP_SCOPES).size,
    GOOGLE_SETUP_SCOPES.length,
    'the setup scope list repeats a scope',
  );
  assert.ok(
    !GOOGLE_SETUP_SCOPES.includes(SCHOOL_OU),
    'the School OU scope stays out of the setup list',
  );
});

test('the connection check still requests exactly the two connection scopes', () => {
  assert.deepEqual(GOOGLE_CUSTOMER_SCOPES, [CUSTOMER, DOMAIN]);
});
