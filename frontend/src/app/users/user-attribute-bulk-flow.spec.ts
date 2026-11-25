import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import type {
  JobAttributeRow,
  UserAttributePreview,
  UserAttributeTarget,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { UserAttributeBulkFlow } from './user-attribute-bulk-flow';

const observedAt = '2026-11-01T12:00:00.000Z';
const previewId = '2f1c6a0e-6d3b-4a1f-9f0e-3c4ce0b6a910';
const tabId = '6f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10';

function preview(): UserAttributePreview {
  return {
    previewId,
    source: 'selection',
    changes: [
      {
        schemaName: 'Student',
        fieldName: 'programs',
        mode: 'add',
        values: ['ESL'],
      },
    ],
    attributeChanges: 18,
    selected: 25,
    eligible: 18,
    unchanged: 7,
    conflicts: 0,
    oldestObservedAt: observedAt,
    stale: false,
    preparedAt: observedAt,
    expiresAt: '2026-11-01T12:10:00.000Z',
    manifestDigest: 'a'.repeat(64),
  };
}

function target(index: number): UserAttributeTarget {
  return {
    userId: `user-${index}`,
    userName: `User ${index}`,
    primaryEmail: `user${index}@example.org`,
    attribute: 'attr:Student.programs',
    currentValue: ['Band'],
    newValue: ['Band', 'ESL'],
    disposition: 'eligible',
    observedAt,
  };
}

function row(
  operation: number,
  extra: Partial<JobAttributeRow> = {},
): JobAttributeRow {
  return {
    operation,
    userId: `user-${operation}`,
    userName: `User ${operation}`,
    primaryEmail: `user${operation}@example.org`,
    attribute: 'attr:Student.programs',
    displayName: 'Programs',
    currentValue: ['Band'],
    newValue: ['Band', 'ESL'],
    outcome: 'succeeded',
    failureText: null,
    ...extra,
  };
}

function requests() {
  const request = vi.fn();
  TestBed.configureTestingModule({
    providers: [{ provide: AuthStore, useValue: { request } }],
  });
  const flow = TestBed.inject(UserAttributeBulkFlow);
  return { request, flow };
}

describe('the Users bulk value flow', () => {
  it('sends the selection key and the changes, never a user list (K27 acceptance 4)', async () => {
    const { request, flow } = requests();
    request.mockResolvedValue(Response.json(preview()));
    const answer = await flow.prepare({ gridId: 'users', tabId }, [
      {
        schemaName: 'Student',
        fieldName: 'programs',
        mode: 'add',
        values: ['ESL'],
      },
    ]);
    expect(answer.ok).toBe(true);
    const [path, body] = request.mock.calls[0] as [string, unknown];
    expect(path).toBe('/api/users/attribute-previews');
    expect(body).toEqual({
      gridId: 'users',
      tabId,
      changes: [
        {
          schemaName: 'Student',
          fieldName: 'programs',
          mode: 'add',
          values: ['ESL'],
        },
      ],
    });
    expect(Object.keys(body as object).sort()).toEqual([
      'changes',
      'gridId',
      'tabId',
    ]);
  });

  it('shows the size sentence when the preview request is refused as too large (K27 acceptance 6)', async () => {
    const { request, flow } = requests();
    request.mockResolvedValue(
      Response.json({ code: 'payload-too-large' }, { status: 413 }),
    );
    const answer = await flow.prepare({ gridId: 'users', tabId }, [
      {
        schemaName: 'Student',
        fieldName: 'programs',
        mode: 'add',
        values: ['ESL'],
      },
    ]);
    expect(answer).toEqual({
      ok: false,
      message: 'The request exceeds the size limit.',
    });
  });

  it('reads one review page at the asked disposition and cursor', async () => {
    const { request, flow } = requests();
    request.mockResolvedValue(
      Response.json({ targets: [target(1)], nextCursor: 'p2' }),
    );
    const answer = await flow.readTargetsPage(previewId, 'eligible', null);
    expect(answer.ok).toBe(true);
    expect(request).toHaveBeenCalledWith(
      `/api/users/attribute-previews/${previewId}/targets?disposition=eligible&limit=10`,
    );
    if (answer.ok) expect(answer.value.nextCursor).toBe('p2');

    await flow.readTargetsPage(previewId, 'unchanged', 'p2');
    expect(request).toHaveBeenLastCalledWith(
      `/api/users/attribute-previews/${previewId}/targets?disposition=unchanged&limit=10&cursor=p2`,
    );
  });

  it('reads one result page at the asked view and cursor, with the server totals', async () => {
    const { request, flow } = requests();
    request.mockResolvedValue(
      Response.json({
        rows: [row(1)],
        totals: { all: 18, failed: 1 },
        nextCursor: 'r2',
      }),
    );
    const answer = await flow.readRowsPage('UAT-014', 'all', null);
    expect(answer.ok).toBe(true);
    expect(request).toHaveBeenCalledWith(
      '/api/jobs/UAT-014/attribute-rows?view=all&limit=10',
    );
    if (answer.ok) {
      expect(answer.value.totals).toEqual({ all: 18, failed: 1 });
      expect(answer.value.nextCursor).toBe('r2');
    }

    await flow.readRowsPage('UAT-014', 'failed', 'r2');
    expect(request).toHaveBeenLastCalledWith(
      '/api/jobs/UAT-014/attribute-rows?view=failed&limit=10&cursor=r2',
    );
  });

  it('names a report that the route cannot parse', async () => {
    const { request, flow } = requests();
    request.mockResolvedValue(Response.json({ rows: 'no' }));
    const answer = await flow.readRowsPage('UAT-014', 'all', null);
    expect(answer).toEqual({
      ok: false,
      message: 'Campus Commander could not read the results. Retry.',
    });
  });
});
