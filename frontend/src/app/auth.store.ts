import { inject } from '@angular/core';
import { patchState, signalStore, withMethods, withState } from '@ngrx/signals';
import { Router } from '@angular/router';
import {
  sessionResponseSchema,
  applicationMetadataSchema,
  type ApplicationMetadata,
  type SessionResponse,
  type Preferences,
} from '@campus/application-contracts';

interface AuthState {
  session: SessionResponse | null;
  metadata: ApplicationMetadata | null;
  error: string | null;
  loading: boolean;
}

export const AuthStore = signalStore(
  { providedIn: 'root' },
  withState<AuthState>({
    session: null,
    metadata: null,
    error: null,
    loading: false,
  }),
  withMethods((store, router = inject(Router)) => ({
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
    async request(path: string, body?: unknown) {
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
      if (response.status === 401) {
        patchState(store, {
          session: null,
          error: 'Your session expired. Sign in again.',
        });
        await router.navigateByUrl('/login');
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
        const response = await this.request('/api/auth/logout', {});
        if (!response.ok && response.status !== 401) throw new Error();
        patchState(store, { session: null, error: null });
        await router.navigateByUrl('/login');
      } catch {
        patchState(store, {
          error: 'Sign-out failed. Retry when the service returns.',
        });
      }
    },
  })),
);
