import assert from 'node:assert/strict';
import test from 'node:test';
import {
  customerSettingsSchema,
  customerSettingsWriteSchema,
} from './customer-settings.ts';

test('customer settings accept only the local display name', () => {
  assert.deepEqual(
    customerSettingsSchema.parse({ displayName: '  Easton District  ' }),
    { displayName: 'Easton District' },
  );
  for (const displayName of [
    '',
    '   ',
    'x'.repeat(257),
    'Line\nbreak',
    'Control\u007f',
  ]) {
    assert.equal(
      customerSettingsSchema.safeParse({ displayName }).success,
      false,
    );
  }
  for (const field of [
    'theme',
    'customerId',
    'primaryDomain',
    'hostname',
    'privateKey',
    'enabledCapabilities',
  ]) {
    assert.equal(
      customerSettingsSchema.safeParse({
        displayName: 'District',
        [field]: 'unsupported',
      }).success,
      false,
    );
  }
});

test('settings writes require an exact customer, request identifier, and bounded revision', () => {
  const input = {
    requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    customerId: 'C0123456',
    expectedRevision: 0,
    settings: { displayName: 'District' },
  };
  assert.equal(customerSettingsWriteSchema.safeParse(input).success, true);
  for (const patch of [
    { requestId: null },
    { customerId: 'my_customer' },
    { expectedRevision: -1 },
    { expectedRevision: 1.2 },
    { expectedRevision: 2147483647 },
  ]) {
    assert.equal(
      customerSettingsWriteSchema.safeParse({ ...input, ...patch }).success,
      false,
    );
  }
});
