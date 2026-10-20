import { routes } from './app.routes';

/** The draft route must match before devices/:deviceId reads "update" as an ID. */
it('declares devices/update before devices/:deviceId', () => {
  const shell = routes.find((route) => route.path === '');
  const paths = (shell?.children ?? []).map((route) => route.path);
  const draft = paths.indexOf('devices/update');
  expect(draft).toBeGreaterThan(-1);
  expect(draft).toBeLessThan(paths.indexOf('devices/:deviceId'));
});

it('declares the Jobs page beside Devices', () => {
  const shell = routes.find((route) => route.path === '');
  const paths = (shell?.children ?? []).map((route) => route.path);
  expect(paths).toContain('jobs');
  expect(paths.indexOf('jobs')).toBeGreaterThan(-1);
  expect(paths).toContain('devices');
});
