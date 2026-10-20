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

it('declares the preview, confirmation, and receipt routes', () => {
  const shell = routes.find((route) => route.path === '');
  const paths = (shell?.children ?? []).map((route) => route.path);
  const receipt = paths.indexOf('jobs/:displayId/receipt');
  const devices = paths.indexOf('devices/update');
  const confirm = paths.indexOf('devices/update/previews/:previewId/confirm');
  const preview = paths.indexOf('devices/update/previews/:previewId');
  const detail = paths.indexOf('devices/:deviceId');
  expect(receipt).toBeGreaterThan(paths.indexOf('jobs'));
  expect(devices).toBeGreaterThan(-1);
  expect(confirm).toBeGreaterThan(devices);
  expect(preview).toBeGreaterThan(confirm);
  expect(detail).toBeGreaterThan(preview);
});
