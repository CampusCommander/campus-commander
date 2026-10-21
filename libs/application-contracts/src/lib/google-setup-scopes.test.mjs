import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GOOGLE_CAPABILITIES,
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
const WRITE = 'https://www.googleapis.com/auth/admin.directory.device.chromeos';
const SCHOOL_OU =
  'https://www.googleapis.com/auth/admin.directory.orgunit.readonly';

test('the setup scope list holds the connection scopes and the device scopes in order', () => {
  assert.deepEqual(GOOGLE_SETUP_SCOPES, [
    CUSTOMER,
    DOMAIN,
    INVENTORY,
    TELEMETRY,
    WRITE,
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

test('the write capability names its label, scope, method, flags, and evidence', () => {
  assert.deepEqual(
    GOOGLE_CAPABILITIES.find(
      (capability) => capability.id === 'device-changes',
    ),
    {
      id: 'device-changes',
      requiredForConnection: false,
      label: 'ChromeOS device changes',
      enabled: true,
      qualified: false,
      scope: WRITE,
      method: 'chromeosdevices.patch',
      source:
        'https://developers.google.com/workspace/admin/directory/reference/rest/v1/chromeosdevices/patch',
      evidence:
        'admin-sdk-mock v0.2.0 only. Methods: chromeosdevices.patch, customer.devices.chromeos.issueCommand, customer.devices.chromeos.commands.get, customer.devices.chromeos.batchChangeStatus.',
    },
  );
});

test('the device-changes evidence names the four Google methods', () => {
  const evidence = GOOGLE_CAPABILITIES.find(
    (capability) => capability.id === 'device-changes',
  ).evidence;
  for (const method of [
    'chromeosdevices.patch',
    'customer.devices.chromeos.issueCommand',
    'customer.devices.chromeos.commands.get',
    'customer.devices.chromeos.batchChangeStatus',
  ])
    assert.ok(evidence.includes(method), `The evidence names ${method}.`);
  assert.match(evidence, /admin-sdk-mock v0\.2\.0 only/);
});
