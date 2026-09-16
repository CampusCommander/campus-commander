import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { chromium } from '@playwright/test';
import { observeKubernetesFaultRequest } from './kubernetes-faults-fixture.mjs';

test('an unavailable API produces a bounded transport failure without an authenticated response', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/')
      response.end('<!doctype html><title>Fault fixture</title>');
    // A service with no reachable endpoints leaves the request pending.
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const observed = await observeKubernetesFaultRequest(page, undefined, 100);
    assert.deepEqual(observed, {
      httpStatus: null,
      status: 'transport-timeout',
    });
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
