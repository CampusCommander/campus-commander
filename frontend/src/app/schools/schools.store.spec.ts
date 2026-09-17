import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { AuthStore } from '../auth.store';
import { SchoolsStore } from './schools.store';

it('supersedes a read started before a save and ignores its delayed response', async () => {
  const session = signal({
    identity: {
      id: 'actor',
      permissionVersion: 1,
      grants: [{ action: 'schools:read', scope: { kind: 'platform' } }],
    },
    csrfToken: 'session',
  });
  let finish: (response: Response) => void = () => {
    throw new Error('The read has not started.');
  };
  const request = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce(
      Response.json({ total: 1, offset: 20, limit: 20, items: [] }),
    );
  TestBed.configureTestingModule({
    providers: [
      SchoolsStore,
      {
        provide: AuthStore,
        useValue: {
          session,
          request,
          metadata: () => ({ phase: 3 }),
          interrupted: () => false,
        },
      },
    ],
  });
  const store = TestBed.inject(SchoolsStore);
  const first = store.refresh(0);
  await store.refresh(20);
  expect(request).toHaveBeenCalledTimes(2);
  expect(store.page()?.offset).toBe(20);
  finish(Response.json({ total: 0, offset: 0, limit: 20, items: [] }));
  await first;
  expect(store.page()?.offset).toBe(20);
  expect(store.page()?.total).toBe(1);
});
