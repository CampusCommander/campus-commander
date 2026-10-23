import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import type { DeviceActionJobReceipt } from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { DeviceActionFlow } from './device-action-flow';
import {
  ACTION_CONFIRMATION_PREFIX,
  DeviceActionConfirmationStore,
} from './device-action-confirmation.store';

const principal = '4f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10';
const otherPrincipal = '9a1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a11';
const previewId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const manifestDigest = 'a'.repeat(64);
const receipt: DeviceActionJobReceipt = {
  jobId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  displayId: 'CMD-001',
  status: 'accepted',
  deviceCount: 6,
  updateCount: 6,
};

function setup() {
  sessionStorage.clear();
  const session = signal({ identity: { id: principal } });
  type Replay = Awaited<ReturnType<DeviceActionFlow['confirm']>>;
  const confirm = vi.fn<DeviceActionFlow['confirm']>(
    async (): Promise<Replay> => ({ ok: true, value: receipt }),
  );
  TestBed.configureTestingModule({
    providers: [
      { provide: AuthStore, useValue: { session } },
      { provide: DeviceActionFlow, useValue: { confirm } },
    ],
  });
  const store = TestBed.inject(DeviceActionConfirmationStore);
  return { store, session, confirm };
}

const submitted = { family: 'command' as const, previewId, manifestDigest };

it('keeps a confirmation for one person and family', () => {
  const { store, session } = setup();
  store.retain(submitted);
  expect(store.pending('command')).toEqual([submitted]);
  expect(store.pending('status')).toEqual([]);
  session.set({ identity: { id: otherPrincipal } });
  expect(store.pending('command')).toEqual([]);
  session.set({ identity: { id: principal } });
  expect(store.pending('command')).toEqual([submitted]);
});

it('replays the retained family, preview, and digest', async () => {
  const { store, confirm } = setup();
  store.retain(submitted);
  await expect(store.resolvePending('command')).resolves.toEqual({
    kind: 'receipt',
    receipt,
  });
  expect(confirm).toHaveBeenCalledWith(
    'command',
    previewId,
    manifestDigest,
    undefined,
  );
  expect(store.pending('command')).toEqual([]);
});

it('replays a retained typed phrase with its digest (D7)', async () => {
  const { store, confirm } = setup();
  store.retain({ ...submitted, typedPhrase: 'WIPE' });
  await store.resolvePending('command');
  expect(confirm).toHaveBeenCalledWith(
    'command',
    previewId,
    manifestDigest,
    'WIPE',
  );
});

it('keeps an uncertain confirmation for another replay', async () => {
  const { store, confirm } = setup();
  confirm.mockResolvedValue({
    ok: false,
    answer: 'confirm-uncertain',
    expiresAt: null,
  });
  store.retain(submitted);
  await expect(store.resolvePending('command')).resolves.toEqual({
    kind: 'uncertain',
    submitted,
  });
  expect(store.pending('command')).toEqual([submitted]);
});

it('clears an expired confirmation because no job exists', async () => {
  const { store, confirm } = setup();
  confirm.mockResolvedValue({
    ok: false,
    answer: 'preview-expired',
    expiresAt: '2026-10-20T19:17:00.000Z',
  });
  store.retain(submitted);
  await expect(store.resolvePending('command')).resolves.toEqual({
    kind: 'expired',
  });
  expect(store.pending('command')).toEqual([]);
});

it('reports a definitive named answer and settles its record', async () => {
  const { store, confirm } = setup();
  confirm.mockResolvedValue({
    ok: false,
    answer: 'preview-not-found',
    expiresAt: null,
  });
  store.retain(submitted);
  await expect(store.resolvePending('command')).resolves.toEqual({
    kind: 'problem',
    answer: 'preview-not-found',
    expiresAt: null,
  });
  expect(store.pending('command')).toEqual([]);
});

// These answers arrive before the API checks for an existing receipt. None of them
// proves that the lost first request created no job.
for (const answer of [
  'forbidden',
  'permission-changed',
  'preview-changed',
  'connection-required',
] as const) {
  it(`keeps the confirmation when a replay answers ${answer}`, async () => {
    const { store, confirm } = setup();
    confirm.mockResolvedValue({ ok: false, answer, expiresAt: null });
    store.retain(submitted);
    await expect(store.resolvePending('command')).resolves.toEqual({
      kind: 'unresolved',
      submitted,
      answer,
      expiresAt: null,
    });
    expect(store.pending('command')).toEqual([submitted]);
  });
}

it('replays the retained identity until a receipt settles it', async () => {
  const { store, confirm } = setup();
  const statusSubmitted = { ...submitted, family: 'status' as const };
  confirm.mockResolvedValueOnce({
    ok: false,
    answer: 'preview-changed',
    expiresAt: null,
  });
  store.retain(statusSubmitted);
  await store.resolvePending('status');
  confirm.mockResolvedValueOnce({ ok: true, value: receipt });
  await expect(store.resolvePending('status')).resolves.toEqual({
    kind: 'receipt',
    receipt,
  });
  expect(confirm).toHaveBeenNthCalledWith(
    1,
    'status',
    previewId,
    manifestDigest,
    undefined,
  );
  expect(confirm).toHaveBeenNthCalledWith(
    2,
    'status',
    previewId,
    manifestDigest,
    undefined,
  );
  expect(store.pending('status')).toEqual([]);
});

it('ignores and clears a malformed record', () => {
  const { store } = setup();
  sessionStorage.setItem(
    `${ACTION_CONFIRMATION_PREFIX}${principal}.command.${previewId}`,
    '{',
  );
  expect(store.pending('command')).toEqual([]);
  expect(sessionStorage.length).toBe(0);
});
