import { routes } from './app.routes';

function shellPaths(): (string | undefined)[] {
  const shell = routes.find((route) => route.path === '');
  return (shell?.children ?? []).map((route) => route.path);
}

it('declares the Devices grid and the device detail route', () => {
  const paths = shellPaths();
  expect(paths).toContain('devices');
  expect(paths).toContain('devices/:deviceId');
});

it('declares the Jobs page beside Devices', () => {
  const paths = shellPaths();
  expect(paths).toContain('jobs');
  expect(paths).toContain('devices');
});

it('keeps the job detail route without the receipt page', () => {
  const paths = shellPaths();
  expect(paths).toContain('jobs/:displayId');
  expect(paths).not.toContain('jobs/:displayId/receipt');
});

it('removes the four update pages from the routes', () => {
  const paths = shellPaths();
  expect(paths).not.toContain('devices/update');
  expect(paths).not.toContain('devices/update/previews/:previewId');
  expect(paths).not.toContain('devices/update/previews/:previewId/confirm');
});
