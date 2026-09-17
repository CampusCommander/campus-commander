import { inject } from '@angular/core';
import { Router, type CanActivateFn, type Routes } from '@angular/router';
import { AuthStore } from './auth.store';

const authenticated: CanActivateFn = async () => {
  const auth = inject(AuthStore),
    router = inject(Router);
  const metadata = await auth.metadataReady();
  if (metadata?.phase === 1) return router.parseUrl('/startup');
  return (await auth.restore()) || router.parseUrl('/login');
};

export const routes: Routes = [
  {
    path: 'invitation',
    title: 'Accept invitation · Campus Commander',
    canActivate: [
      async () => {
        const auth = inject(AuthStore);
        const router = inject(Router);
        return (
          (await auth.metadataReady())?.phase === 3 || router.parseUrl('/login')
        );
      },
    ],
    loadComponent: () =>
      import('./invitations/redeem').then((m) => m.RedeemInvitation),
  },
  {
    path: 'setup',
    title: 'Administrator setup · Campus Commander',
    loadComponent: () => import('./setup/setup').then((m) => m.Setup),
  },
  {
    path: 'login',
    title: 'Sign in · Campus Commander',
    loadComponent: () => import('./login/login').then((m) => m.Login),
  },
  {
    path: 'startup',
    title: 'Campus Commander startup',
    canActivate: [
      async () => {
        const auth = inject(AuthStore),
          router = inject(Router);
        return (
          (await auth.metadataReady())?.phase === 1 || router.parseUrl('/')
        );
      },
    ],
    loadComponent: () => import('./startup/startup').then((m) => m.Startup),
  },
  {
    path: '',
    loadComponent: () => import('./shell/shell').then((m) => m.Shell),
    canActivate: [authenticated],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'account' },
      {
        path: 'invitations',
        title: 'Platform invitations · Campus Commander',
        canActivate: [
          () => {
            const auth = inject(AuthStore);
            const router = inject(Router);
            return (
              auth.can('platform-users:read', { kind: 'platform' }) ||
              router.parseUrl('/account')
            );
          },
        ],
        loadComponent: () =>
          import('./invitations/invitations').then((m) => m.Invitations),
      },
      {
        path: 'account',
        title: 'Your account · Campus Commander',
        loadComponent: () => import('./account/account').then((m) => m.Account),
      },
      {
        path: 'diagnostics',
        title: 'Diagnostics · Campus Commander',
        loadComponent: () =>
          import('./diagnostics/diagnostics').then((m) => m.Diagnostics),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
