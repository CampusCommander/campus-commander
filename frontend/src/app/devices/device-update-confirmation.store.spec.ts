import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import type {
  DeviceUpdateJobReceipt,
  DeviceUpdatePreview,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { DeviceUpdateFlow } from './device-update-flow';
import {
  CONFIRMATION_PREFIX,
  DeviceUpdateConfirmationStore,
} from './device-update-confirmation.store';

const principal = '4f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10';
const otherPrincipal = '9a1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a11';
const previewId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const manifestDigest = 'a'.repeat(64);

const preview: DeviceUpdatePreview = {
  previewId,
  displayId: 'PV-006',
  changes: [
    { field: 'annotatedLocation', mode: 'replace', value: 'North lab' },
  ],
  fieldChanges: 6,
  selected: 6,
  eligible: 6,
  unchanged: 0,
  excluded: 0,
  conflicts: 0,
  oldestObservedAt: '2026-10-19T10:00:00.000Z',
  stale: false,
  preparedAt: '2026-10-19T12:00:00.000Z',
  expiresAt: '2026-10-19T12:15:00.000Z',
  manifestDigest,
};

const receipt: DeviceUpdateJobReceipt = {
  jobId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  displayId: 'UPD-006',
  status: 'accepted',
  deviceCount: 6,
  updateCount: 6,
};

function setup() {
  sessionStorage.clear();
  const session = signal({ identity: { id: principal } });
  type Confirm = DeviceUpdateFlow['confirm'];
  const confirm = vi.fn<Confirm>(
    async (): Promise<Awaited<ReturnType<Confirm>>> => ({
      ok: true,
      value: receipt,
    }),
  );
  const prepareFromDraft = vi.fn<DeviceUpdateFlow['prepareFromDraft']>(
    async () => ({ ok: true, value: preview }),
  );
  TestBed.configureTestingModule({
    providers: [
      { provide: AuthStore, useValue: { session } },
      { provide: DeviceUpdateFlow, useValue: { confirm, prepareFromDraft } },
    ],
  });
  const store = TestBed.inject(DeviceUpdateConfirmationStore);
  return { store, session, confirm, prepareFromDraft };
}

const submitted = { previewId, manifestDigest };

it('keeps a lost confirmation under the person, preview, and digest', () => {
  const { store, session } = setup();
  store.retain(submitted);
  expect(store.pending()).toEqual([submitted]);
  expect(store.retained(previewId)).toEqual(submitted);
  session.set({ identity: { id: otherPrincipal } });
  expect(store.pending()).toEqual([]);
  expect(store.retained(previewId)).toBeNull();
  session.set({ identity: { id: principal } });
  expect(store.pending()).toEqual([submitted]);
});

it('replays the retained preview and digest', async () => {
  const { store, confirm, prepareFromDraft } = setup();
  store.retain(submitted);
  // The record travels with the receipt, so a grid save can settle its rows (DRAFT-02).
  await expect(store.preparePreview()).resolves.toEqual({
    kind: 'receipt',
    receipt,
    submitted,
  });
  expect(confirm).toHaveBeenCalledWith(previewId, manifestDigest);
  expect(prepareFromDraft).not.toHaveBeenCalled();
  expect(store.pending()).toEqual([]);
});

it('keeps an uncertain confirmation for another replay', async () => {
  const { store, confirm, prepareFromDraft } = setup();
  confirm.mockResolvedValue({
    ok: false,
    answer: 'confirm-uncertain',
    expiresAt: null,
  });
  store.retain(submitted);
  await expect(store.preparePreview()).resolves.toEqual({
    kind: 'uncertain',
    submitted,
  });
  expect(prepareFromDraft).not.toHaveBeenCalled();
  expect(store.pending()).toEqual([submitted]);
});

it('clears an expired confirmation because no job exists', async () => {
  const { store, confirm, prepareFromDraft } = setup();
  confirm.mockResolvedValue({
    ok: false,
    answer: 'preview-expired',
    expiresAt: '2026-10-19T12:15:00.000Z',
  });
  store.retain(submitted);
  await expect(store.preparePreview()).resolves.toEqual({
    kind: 'preview',
    preview,
  });
  expect(prepareFromDraft).toHaveBeenCalledTimes(1);
  expect(store.pending()).toEqual([]);
});

it('clears a connection-changed confirmation and reports its answer', async () => {
  const { store, confirm, prepareFromDraft } = setup();
  confirm.mockResolvedValue({
    ok: false,
    answer: 'connection-changed',
    expiresAt: null,
  });
  store.retain(submitted);
  await expect(store.preparePreview()).resolves.toEqual({
    kind: 'problem',
    answer: 'connection-changed',
    expiresAt: null,
  });
  expect(prepareFromDraft).not.toHaveBeenCalled();
  expect(store.pending()).toEqual([]);
});

it('clears a definitive named answer and reports it', async () => {
  const { store, confirm, prepareFromDraft } = setup();
  confirm.mockResolvedValue({
    ok: false,
    answer: 'preview-not-found',
    expiresAt: null,
  });
  store.retain(submitted);
  await expect(store.preparePreview()).resolves.toEqual({
    kind: 'problem',
    answer: 'preview-not-found',
    expiresAt: null,
  });
  expect(prepareFromDraft).not.toHaveBeenCalled();
  expect(store.pending()).toEqual([]);
});

// These answers arrive before the API checks for an existing receipt. None of them
// proves that the lost first request created no job.
for (const answer of [
  'forbidden',
  'permission-changed',
  'preview-changed',
  'connection-required',
] as const) {
  it(`keeps the confirmation and starts no preview when a replay answers ${answer}`, async () => {
    const { store, confirm, prepareFromDraft } = setup();
    confirm.mockResolvedValue({ ok: false, answer, expiresAt: null });
    store.retain(submitted);
    await expect(store.preparePreview()).resolves.toEqual({
      kind: 'unresolved',
      submitted,
      answer,
      expiresAt: null,
    });
    expect(prepareFromDraft).not.toHaveBeenCalled();
    expect(store.pending()).toEqual([submitted]);
  });
}

it('replays the retained identity until a receipt settles it', async () => {
  const { store, confirm } = setup();
  confirm.mockResolvedValueOnce({
    ok: false,
    answer: 'preview-changed',
    expiresAt: null,
  });
  store.retain(submitted);
  await store.resolvePending();
  confirm.mockResolvedValueOnce({ ok: true, value: receipt });
  await expect(store.resolvePending()).resolves.toEqual({
    kind: 'receipt',
    receipt,
    submitted,
  });
  expect(confirm).toHaveBeenNthCalledWith(1, previewId, manifestDigest);
  expect(confirm).toHaveBeenNthCalledWith(2, previewId, manifestDigest);
  expect(store.pending()).toEqual([]);
});

it('ignores and clears a malformed record', () => {
  const { store } = setup();
  sessionStorage.setItem(
    `${CONFIRMATION_PREFIX}${principal}.${previewId}`,
    JSON.stringify({ previewId: 'not-a-preview' }),
  );
  expect(store.pending()).toEqual([]);
  expect(sessionStorage.length).toBe(0);
});
