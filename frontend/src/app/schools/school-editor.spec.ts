import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { AuthStore } from '../auth.store';
import { SchoolEditor } from './school-editor';
import { SchoolsStore } from './schools.store';

it.each(['permission', 'session', 'interruption', 'destroy'])(
  'discards delayed school previews after %s changes and preserves the recovery identity',
  async (change) => {
    sessionStorage.clear();
    const interrupted = signal(false);
    const session = signal({
      identity: {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        permissionVersion: 1,
        grants: [{ action: 'schools:manage', scope: { kind: 'platform' } }],
      },
      csrfToken: 'original',
    });
    let finish: () => void = () => {
      throw new Error('The response has not started.');
    };
    const request = vi.fn(
      async (_path: string, input: Record<string, unknown>) =>
        new Response(
          new ReadableStream({
            start(controller) {
              finish = () => {
                controller.enqueue(
                  new TextEncoder().encode(
                    JSON.stringify({
                      ...input,
                      approvedIds: ['root'],
                      affectedPrincipalCount: 0,
                      invitationIds: [],
                      expiresAt: new Date(Date.now() + 600000).toISOString(),
                      appliedAt: null,
                      revision: null,
                    }),
                  ),
                );
                controller.close();
              };
            },
          }),
        ),
    );
    await TestBed.configureTestingModule({
      imports: [SchoolEditor],
      providers: [
        SchoolsStore,
        {
          provide: AuthStore,
          useValue: {
            session,
            interrupted,
            request,
            can: () => !interrupted(),
            metadata: () => ({ phase: 3 }),
          },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(SchoolEditor);
    const editor = fixture.componentInstance;
    const store = TestBed.inject(SchoolsStore);
    fixture.detectChanges();
    store.references.set({
      customerId: 'C0123456',
      generation: 1,
      fresh: true,
      failure: null,
      checkedAt: null,
      checking: false,
      retryAt: null,
      observation: {
        customerId: 'C0123456',
        generation: 1,
        revision: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        observedAt: new Date(store.now()).toISOString(),
        verified: true,
        complete: true,
        units: [{ id: 'root', parentId: null, name: 'Root', path: '/' }],
      },
    });
    editor.begin();
    editor.editName('School');
    editor.selectedId.set('root');
    editor.addRule('include');
    expect(editor.canPreview()).toBe(true);
    const pending = editor.preview();
    await editor.preview();
    expect(request).toHaveBeenCalledTimes(1);
    const reviewId = editor.pending()?.input.id;
    if (change === 'destroy') fixture.destroy();
    else {
      if (change === 'permission')
        session.update((value) => ({
          ...value,
          identity: { ...value.identity, permissionVersion: 2 },
        }));
      if (change === 'session')
        session.update((value) => ({ ...value, csrfToken: 'renewed' }));
      if (change === 'interruption') interrupted.set(true);
      fixture.detectChanges();
    }
    finish();
    await pending;
    expect(editor.review()).toBeNull();
    expect(editor.pending()?.input.id).toBe(reviewId);
    expect(editor.canConfirm()).toBe(false);
  },
);
