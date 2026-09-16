import { inject } from '@angular/core';
import { patchState, signalStore, withMethods, withState } from '@ngrx/signals';
import { Router } from '@angular/router';
import {
  sessionResponseSchema,
  applicationMetadataSchema,
  type ApplicationMetadata,
  type SessionResponse,
  type Preferences,
  isAuthorized,
  type Action,
  type ResourceScope,
} from '@campus/application-contracts';

interface AuthState {
  session: SessionResponse | null;
  metadata: ApplicationMetadata | null;
  error: string | null;
  loading: boolean;
  interrupted: boolean;
  interruptedPrincipalId: string | null;
}

export const AuthStore = signalStore(
  { providedIn: 'root' },
  withState<AuthState>({
    session: null,
    metadata: null,
    error: null,
    loading: false,
    interrupted: false,
    interruptedPrincipalId: null,
  }),
  withMethods((store, router = inject(Router)) => ({
    can(action: Action, resource: ResourceScope) {
      return (
        store.metadata()?.phase === 3 &&
        isAuthorized(store.session()?.identity.grants ?? [], action, resource)
      );
    },
    async metadataReady(refresh = false) {
      if (store.metadata() && !refresh) return store.metadata();
      try {
        const response = await fetch('/api/application', {
          signal: AbortSignal.timeout(5000),
          credentials: 'same-origin',
        });
        if (!response.ok) throw new Error();
        const metadata = applicationMetadataSchema.parse(await response.json());
        patchState(store, { metadata, error: null });
        return metadata;
      } catch {
        patchState(store, {
          error:
            'The application is unavailable. Retry or contact the installation operator.',
        });
        return null;
      }
    },
    async restore() {
      patchState(store, { loading: true });
      try {
        const response = await fetch('/api/auth/session', {
          signal: AbortSignal.timeout(5000),
          credentials: 'same-origin',
        });
        if (response.status === 401) {
          patchState(store, { session: null, error: null });
          return false;
        }
        if (!response.ok) throw new Error();
        const session = sessionResponseSchema.parse(await response.json());
        patchState(store, { session, error: null });
        return true;
      } catch {
        patchState(store, {
          session: null,
          error:
            'Your session is unavailable. Retry or contact the installation operator.',
        });
        return false;
      } finally {
        patchState(store, { loading: false });
      }
    },
    async resume() {
      const expected = store.interruptedPrincipalId();
      if (!expected || store.loading()) return;
      patchState(store, { loading: true });
      try {
        const response = await fetch('/api/auth/session', {
          credentials: 'same-origin',
          signal: AbortSignal.timeout(5000),
        });
        if (response.status === 401) {
          patchState(store, {
            error:
              'Sign in in another tab, then recheck access here. Your form values remain in this tab.',
          });
          return;
        }
        if (!response.ok) throw new Error();
        const session = sessionResponseSchema.parse(await response.json());
        if (session.identity.id !== expected) {
          patchState(store, {
            session: null,
            interrupted: false,
            interruptedPrincipalId: null,
            error:
              'A different principal signed in. The previous form was closed.',
          });
          await router.navigateByUrl('/login');
          return;
        }
        patchState(store, {
          session,
          interrupted: false,
          interruptedPrincipalId: null,
          error: null,
        });
        if (
          (router.url.startsWith('/platform-users') ||
            router.url.startsWith('/invitations')) &&
          !isAuthorized(session.identity.grants, 'platform-users:read', {
            kind: 'platform',
          })
        ) {
          await router.navigateByUrl('/account');
          patchState(store, {
            error: 'Your current access does not permit the previous page.',
          });
        }
      } catch {
        patchState(store, {
          error:
            'Access verification is unavailable. Retry when your connection returns. Your form values remain in this tab.',
        });
      } finally {
        patchState(store, { loading: false });
      }
    },
    async request(path: string, body?: unknown) {
      if (store.interrupted())
        return Response.json({ code: 'access-changed' }, { status: 401 });
      const requestedSession = store.session();
      const response = await fetch(path, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        signal: AbortSignal.timeout(45000),
        headers:
          body === undefined
            ? {}
            : {
                'content-type': 'application/json',
                'x-csrf-token': store.session()?.csrfToken ?? '',
              },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (
        response.status === 401 &&
        !store.interrupted() &&
        (!store.session() ||
          store.session()?.csrfToken === requestedSession?.csrfToken)
      ) {
        if (store.metadata()?.phase === 3 && requestedSession) {
          const result = await response
            .clone()
            .json()
            .catch(() => null);
          patchState(store, {
            session: null,
            interrupted: true,
            interruptedPrincipalId: requestedSession.identity.id,
            error:
              result?.code === 'access-changed'
                ? 'Your application access changed. Your form values remain in this tab.'
                : 'Your session ended. Your form values remain in this tab.',
          });
        } else {
          patchState(store, {
            session: null,
            error: 'Your session expired. Sign in again.',
          });
          await router.navigateByUrl('/login');
        }
      }
      return response;
    },
    async savePreferences(preferences: Preferences) {
      const response = await this.request('/api/auth/preferences', preferences);
      if (!response.ok)
        throw new Error('Your preference was not saved. Retry.');
      patchState(store, (state) => ({
        session: state.session
          ? {
              ...state.session,
              identity: { ...state.session.identity, preferences },
            }
          : null,
      }));
    },
    async logout() {
      try {
        let response: Response;
        if (store.interrupted()) {
          const current = await fetch('/api/auth/session', {
            credentials: 'same-origin',
            signal: AbortSignal.timeout(5000),
          });
          if (current.status === 401) response = current;
          else {
            if (!current.ok) throw new Error();
            const session = sessionResponseSchema.parse(await current.json());
            response = await fetch('/api/auth/logout', {
              method: 'POST',
              credentials: 'same-origin',
              signal: AbortSignal.timeout(5000),
              headers: {
                'content-type': 'application/json',
                'x-csrf-token': session.csrfToken,
              },
              body: '{}',
            });
          }
        } else response = await this.request('/api/auth/logout', {});
        if (!response.ok && response.status !== 401) throw new Error();
        patchState(store, {
          session: null,
          error: null,
          interrupted: false,
          interruptedPrincipalId: null,
        });
        await router.navigateByUrl('/login');
      } catch {
        patchState(store, {
          error: 'Sign-out failed. Retry when the service returns.',
        });
      }
    },
  })),
);
