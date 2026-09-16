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
    path: 'login',
    title: 'Sign in · Campus Commander',
    data: { title: 'Sign in' },
    loadComponent: () => import('./login/login').then((m) => m.Login),
  },
  {
    path: 'startup',
    title: 'Campus Commander startup',
    data: { title: 'Startup' },
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
        path: 'account',
        title: 'Your account · Campus Commander',
        data: { title: 'Your account' },
        loadComponent: () => import('./account/account').then((m) => m.Account),
      },
      {
        path: 'diagnostics',
        title: 'Diagnostics · Campus Commander',
        data: { title: 'Diagnostics' },
        loadComponent: () =>
          import('./diagnostics/diagnostics').then((m) => m.Diagnostics),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
