import { inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';
import { AuthStore } from '../auth.store';
import { DeviceWriteAccessStore } from './device-write-access.store';

/** The draft page opens only while Google granted device changes (design 4.3). */
export const deviceUpdateWritable: CanActivateFn = async () => {
  const auth = inject(AuthStore);
  const access = inject(DeviceWriteAccessStore);
  const router = inject(Router);
  const permitted = auth
    .session()
    ?.identity.grants.some((grant) => grant.action === 'devices:write');
  if (!permitted) return router.parseUrl('/devices');
  const state = await access.load();
  return state?.state === 'granted' || router.parseUrl('/devices');
};
