import { describe, expect, it, vi } from 'vitest';
import type { UserRow } from '@campus/application-contracts';
import { UserRowRefresh } from './user-row-refresh';

const row = (recordVersion: number, fullName = 'Aaliyah Brooks'): UserRow => ({
  userId: '110000000000000000001',
  primaryEmail: 'aaliyah.brooks@example.org',
  orgUnitPath: '/Students/High School',
  givenName: 'Aaliyah',
  familyName: 'Brooks',
  fullName,
  suspended: false,
  suspensionReason: null,
  archived: false,
  lastLoginTime: '2026-11-01T12:00:00.000Z',
  creationTime: '2020-08-01T12:00:00.000Z',
  twoStepEnrolled: true,
  department: null,
  title: null,
  aliases: [],
  customSchemas: {},
  lastEntitySync: '2026-11-16T10:00:00.000Z',
  stale: false,
  recordVersion,
});

function grid(initial: UserRow) {
  const node = {
    group: false,
    data: initial,
    updateData: vi.fn((next: UserRow) => {
      node.data = next;
    }),
  };
  const api = {
    forEachNode: (callback: (item: typeof node) => void) => callback(node),
    getRowNode: (id: string) => (id === initial.userId ? node : undefined),
  } as unknown as Parameters<UserRowRefresh['attach']>[0];
  return { node, api };
}

describe('the row refresh', () => {
  it('rejects an answer older than the held record (R8)', () => {
    const { node, api } = grid(row(3));
    const refresh = new UserRowRefresh();
    refresh.attach(api);
    refresh.apply([row(2, 'Old name')]);
    expect(node.updateData).not.toHaveBeenCalled();
    expect(node.data.fullName).toBe('Aaliyah Brooks');
    refresh.apply([row(3, 'Same version')]);
    expect(node.updateData).toHaveBeenCalledWith(row(3, 'Same version'));
    refresh.apply([row(4, 'Newer')]);
    expect(node.data.fullName).toBe('Newer');
  });

  it('drops the answer of a grid that a replacement replaced (R8)', () => {
    const first = grid(row(1));
    const second = grid(row(1));
    const refresh = new UserRowRefresh();
    refresh.attach(first.api);
    const attachment = refresh.current();
    refresh.detach(first.api);
    refresh.attach(second.api);
    refresh.apply([row(2, 'Stale grid')], attachment);
    expect(first.node.updateData).not.toHaveBeenCalled();
    expect(second.node.updateData).not.toHaveBeenCalled();
    refresh.apply([row(2, 'Current grid')]);
    expect(second.node.data.fullName).toBe('Current grid');
  });

  it('notifies only the rows that pass the freshness fence (R1-I)', () => {
    const { api } = grid(row(3));
    const refresh = new UserRowRefresh();
    refresh.attach(api);
    const seen = vi.fn();
    refresh.onApply(seen);
    refresh.apply([row(2, 'Older'), row(4, 'Newer')]);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(
      (seen.mock.calls[0][0] as UserRow[]).map((row) => row.fullName),
    ).toEqual(['Newer']);
  });

  it('lists the held IDs that pass a test', () => {
    const { api } = grid(row(1));
    const refresh = new UserRowRefresh();
    refresh.attach(api);
    expect(refresh.held()).toEqual(['110000000000000000001']);
    expect(refresh.held((candidate) => candidate.stale)).toEqual([]);
  });

  it('updates nothing after the grid leaves', () => {
    const { node, api } = grid(row(1));
    const refresh = new UserRowRefresh();
    refresh.attach(api);
    refresh.detach(api);
    refresh.apply([row(2)]);
    expect(node.updateData).not.toHaveBeenCalled();
  });
});
