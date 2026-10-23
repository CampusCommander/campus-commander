import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { vi } from 'vitest';
import { AuthStore } from '../auth.store';
import { DeviceActionFlow, actionFamilyPath } from './device-action-flow';
import { DevicesStore } from './devices.store';

const tabId = '6f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10';
const previewId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const preview = {
  previewId,
  displayId: 'PV-002',
  action: 'reboot',
  commandType: 'REBOOT',
  statusAction: null,
  deprovisionReason: null,
  selected: 8,
  eligible: 6,
  excluded: 2,
  oldestObservedAt: '2026-10-20T10:00:00.000Z',
  stale: false,
  preparedAt: '2026-10-20T19:02:00.000Z',
  expiresAt: '2026-10-20T19:17:00.000Z',
  manifestDigest: 'a'.repeat(64),
};

function setup(response: (path: string, body: unknown) => Response) {
  const request = vi.fn(async (path: string, body?: unknown) =>
    response(path, body),
  );
  TestBed.configureTestingModule({
    providers: [
      {
        provide: DevicesStore,
        useValue: { selectionTab: tabId },
      },
      {
        provide: AuthStore,
        useValue: {
          session: signal(null),
          metadata: signal({ phase: 3 }),
          request,
        },
      },
    ],
  });
  return { flow: TestBed.inject(DeviceActionFlow), request };
}

it('maps each family to its route family', () => {
  expect(actionFamilyPath('command')).toBe('/api/devices/commands');
  expect(actionFamilyPath('status')).toBe('/api/devices/status-changes');
});

it('prepares a Reboot preview under the command family', async () => {
  const { flow, request } = setup(() =>
    Response.json(preview, { status: 201 }),
  );
  const result = await flow.prepare('command', 'reboot');
  expect(result.ok).toBe(true);
  expect(request).toHaveBeenCalledWith('/api/devices/commands/previews', {
    gridId: 'devices',
    tabId,
    commandType: 'REBOOT',
  });
});

it('prepares a status preview with the chosen status action', async () => {
  const { flow, request } = setup(() =>
    Response.json(preview, { status: 201 }),
  );
  await flow.prepare('status', 'reenable');
  expect(request).toHaveBeenCalledWith('/api/devices/status-changes/previews', {
    gridId: 'devices',
    tabId,
    statusAction: 'reenable',
  });
});

it('freezes the Deprovision reason into its preview body (D12)', async () => {
  const { flow, request } = setup(() =>
    Response.json(preview, { status: 201 }),
  );
  await flow.prepare(
    'status',
    'deprovision',
    'DEPROVISION_REASON_RETIRING_DEVICE',
  );
  expect(request).toHaveBeenCalledWith('/api/devices/status-changes/previews', {
    gridId: 'devices',
    tabId,
    statusAction: 'deprovision',
    deprovisionReason: 'DEPROVISION_REASON_RETIRING_DEVICE',
  });
});

it('refuses a Deprovision preview without a reason', async () => {
  const { flow, request } = setup(() =>
    Response.json(preview, { status: 201 }),
  );
  await expect(flow.prepare('status', 'deprovision')).rejects.toThrow(
    'A Deprovision preview needs a reason.',
  );
  expect(request).not.toHaveBeenCalled();
});

it('reads the frozen summary and every target page', async () => {
  const { flow, request } = setup((path) =>
    path.includes('/targets')
      ? Response.json({
          targets: [
            {
              deviceId: 'device-1',
              serialNumber: 'C0A1-0001',
              orgUnitPath: '/School A',
              observedStatus: 'ACTIVE',
              observedAt: '2026-10-20T18:50:00.000Z',
              disposition: 'eligible',
              exclusionReason: null,
            },
          ],
          nextCursor: null,
        })
      : Response.json(preview),
  );
  const summary = await flow.readPreview('command', previewId);
  expect(summary.ok).toBe(true);
  const targets = await flow.readTargets('command', previewId);
  expect(targets.ok).toBe(true);
  if (targets.ok) expect(targets.value).toHaveLength(1);
  expect(request).toHaveBeenCalledWith(
    `/api/devices/commands/previews/${previewId}`,
  );
  expect(request).toHaveBeenCalledWith(
    `/api/devices/commands/previews/${previewId}/targets?limit=1000`,
  );
});

it('confirms with the digest and the acknowledgment', async () => {
  const { flow, request } = setup(() =>
    Response.json(
      {
        jobId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        displayId: 'CMD-001',
        status: 'accepted',
        deviceCount: 6,
        updateCount: 6,
      },
      { status: 201 },
    ),
  );
  const result = await flow.confirm('command', previewId, 'b'.repeat(64));
  expect(result.ok).toBe(true);
  expect(request).toHaveBeenCalledWith(
    `/api/devices/commands/previews/${previewId}/confirm`,
    { manifestDigest: 'b'.repeat(64), acknowledged: true },
  );
});

it('sends the typed phrase of an action that requires one (D7)', async () => {
  const { flow, request } = setup(() =>
    Response.json(
      {
        jobId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        displayId: 'CMD-001',
        status: 'accepted',
        deviceCount: 6,
        updateCount: 6,
      },
      { status: 201 },
    ),
  );
  await flow.confirm('command', previewId, 'b'.repeat(64), 'WIPE');
  expect(request).toHaveBeenCalledWith(
    `/api/devices/commands/previews/${previewId}/confirm`,
    {
      manifestDigest: 'b'.repeat(64),
      acknowledged: true,
      typedPhrase: 'WIPE',
    },
  );
});

it('maps the no-eligible answer to nothing-to-update', async () => {
  const { flow } = setup(() =>
    Response.json({ reason: 'nothing-to-update' }, { status: 422 }),
  );
  const result = await flow.confirm('status', previewId, 'b'.repeat(64));
  expect(result).toEqual({
    ok: false,
    answer: 'nothing-to-update',
    expiresAt: null,
  });
});

it('keeps the expiry of an expired preview', async () => {
  const { flow } = setup(() =>
    Response.json(
      { reason: 'preview-expired', expiresAt: '2026-10-20T19:17:00.000Z' },
      { status: 410 },
    ),
  );
  const result = await flow.readPreview('status', previewId);
  expect(result).toEqual({
    ok: false,
    answer: 'preview-expired',
    expiresAt: '2026-10-20T19:17:00.000Z',
  });
});
