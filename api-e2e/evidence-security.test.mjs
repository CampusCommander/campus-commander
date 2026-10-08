import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  access,
  mkdir,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import {
  EvidenceSecurity,
  captureEvidenceOutput,
} from './evidence-security.mjs';

const secret = 'fixture-private-value:alpha\nbeta';

test('redaction rejects raw, encoded, escaped, and binary secret values without exposing them', () => {
  const security = new EvidenceSecurity();
  security.register('fixture-secret', secret);
  for (const value of [
    secret,
    JSON.stringify(secret),
    encodeURIComponent(secret),
    Buffer.from(secret).toString('base64'),
  ]) {
    assert.throws(
      () => security.assertSafe(`prefix${value}suffix`, 'fixture report'),
      (error) =>
        error.message ===
          'fixture report contains a protected fixture-secret value.' &&
        !error.message.includes(secret),
    );
  }
  const key = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
  security.register('encryption-key', key);
  for (const value of [key, key.toString('hex'), key.toString('base64')]) {
    assert.throws(
      () => security.assertSafe(value, 'fixture report'),
      /protected encryption-key/,
    );
  }
  assert.throws(
    () => security.assertSafe('-----BEGIN PRIVATE KEY-----', 'report'),
    /private key material/,
  );
});

test('response registration covers cookies and nested tokens without treating normal error codes as secrets', () => {
  const security = new EvidenceSecurity();
  security.observeResponse(
    { 'set-cookie': ['__Host-session=opaque-cookie-value; Secure'] },
    JSON.stringify({
      csrfToken: 'fixture-csrf-value',
      csrf: 'fixture-setup-csrf-value',
      nested: { access_token: 'fixture-access-value' },
      code: 'forbidden',
    }),
  );
  for (const value of [
    'opaque-cookie-value',
    'fixture-csrf-value',
    'fixture-setup-csrf-value',
    'fixture-access-value',
  ]) {
    assert.throws(() => security.assertSafe(value, 'response'), /protected/);
  }
  security.assertSafe('forbidden', 'safe response');
  const pairingCode = 'a'.repeat(64);
  security.observeResponse({}, JSON.stringify({ code: pairingCode }));
  assert.throws(
    () => security.assertSafe(pairingCode, 'pairing response'),
    /pairing-code/,
  );
});

test('artifact scan removes unsafe files, rejects unchecked images, and retains safe evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cc-evidence-security-'));
  try {
    const security = new EvidenceSecurity();
    security.register('fixture-secret', secret);
    await mkdir(join(directory, 'nested'));
    await writeFile(
      join(directory, 'nested', 'unsafe.json'),
      JSON.stringify({ value: secret }),
    );
    await writeFile(join(directory, 'safe.json'), '{"status":"passed"}');
    await writeFile(join(directory, 'unchecked.png'), 'image');
    await writeFile(join(directory, 'unchecked.jpg'), 'image');
    await assert.rejects(
      security.scan(directory),
      (error) =>
        error.message.includes('fixture-secret') &&
        error.message.includes('screenshot content check') &&
        error.message.includes('unsupported evidence format') &&
        !error.message.includes(secret),
    );
    await assert.rejects(access(join(directory, 'nested', 'unsafe.json')));
    await assert.rejects(access(join(directory, 'unchecked.png')));
    await assert.rejects(access(join(directory, 'unchecked.jpg')));
    const report = await security.scan(directory, {
      api: 'safe service output',
    });
    assert.equal(report.status, 'passed');
    assert.equal(report.files.length, 1);
    assert.equal(report.files[0].name, 'safe.json');
    assert.equal(report.secretCategories['fixture-secret'], 1);
    assert.equal(JSON.stringify(report).includes(secret), false);
    await assert.rejects(
      security.scan(directory, { api: secret }),
      /api contains a protected/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('screenshot checks reject content changes and bind passing checks to exact image bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cc-screenshot-security-'));
  try {
    const security = new EvidenceSecurity();
    security.register('fixture-secret', secret);
    const path = join(directory, 'screen.png');
    let content = 'safe document';
    let exposeAfterCapture = true;
    const page = {
      context: () => ({ cookies: async () => [] }),
      evaluate: async () => content,
      screenshot: async () => {
        const bytes = Buffer.from('synthetic screenshot');
        await writeFile(path, bytes);
        if (exposeAfterCapture) content = secret;
        return bytes;
      },
    };
    await assert.rejects(
      security.screenshot(page, { path }),
      /protected fixture-secret/,
    );
    await assert.rejects(access(path));
    const failureReport = await readFile(
      `${path}.redaction-failure.json`,
      'utf8',
    );
    assert.equal(failureReport.includes(secret), false);
    assert.equal(
      JSON.parse(failureReport).reason,
      'screenshot-content-check-failed',
    );
    await rm(`${path}.redaction-failure.json`);
    content = 'safe document';
    exposeAfterCapture = false;
    await security.screenshot(page, { path });
    const report = await security.scan(directory);
    assert.equal(report.screenshotChecks, 1);
    assert.equal(report.files.length, 1);
    await writeFile(
      path,
      Buffer.concat([await readFile(path), Buffer.from('changed')]),
    );
    await assert.rejects(security.scan(directory), /matching screenshot/);
    await symlink('/tmp', join(directory, 'outside'));
    await assert.rejects(security.scan(directory), /regular files/);
    await assert.rejects(access(join(directory, 'outside')));
    await access('/tmp');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('process evidence includes stderr and never exposes output on process failure', () => {
  const security = new EvidenceSecurity();
  security.register('fixture-secret', secret);
  const script =
    'process.stdout.write("safe"); process.stderr.write(process.argv[1]);';
  const output = captureEvidenceOutput(process.execPath, [
    '-e',
    script,
    secret,
  ]);
  assert.throws(
    () => security.assertSafe(output, 'service logs'),
    /protected fixture-secret/,
  );
  assert.throws(
    () =>
      captureEvidenceOutput(process.execPath, [
        '-e',
        `${script} process.exitCode=1;`,
        secret,
      ]),
    (error) =>
      error.message === 'Evidence process did not complete successfully.' &&
      !error.message.includes(secret),
  );
});

test('browser observation captures transient cookies and completed JSON bodies', async () => {
  const security = new EvidenceSecurity();
  const context = new EventEmitter();
  await security.newContext({ newContext: async () => context }, {});
  const response = {
    headersArray: async () => [
      {
        name: 'Set-Cookie',
        value: 'invitation=transient-cookie-secret; Secure',
      },
    ],
    url: () => 'https://fixture.invalid/api/auth/session',
    status: () => 200,
    headers: () => ({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify({ token: secret }),
  };
  context.emit('response', response);
  context.emit('requestfinished', {
    url: response.url,
    response: async () => response,
  });
  await security.observePendingResponses();
  for (const value of ['transient-cookie-secret', secret])
    assert.throws(() => security.assertSafe(value, 'logs'), /protected/);
  context.emit('requestfinished', {
    url: () => 'https://fixture.invalid/api/auth/session',
    response: async () => ({
      url: () => 'https://fixture.invalid/api/auth/session',
      status: () => 200,
      headers: () => ({ 'content-type': 'application/json' }),
      text: async () => {
        throw new Error(secret);
      },
    }),
  });
  await assert.rejects(
    security.observePendingResponses(),
    (error) =>
      error.message ===
        'Browser response secret registration did not complete.' &&
      !error.message.includes(secret),
  );
});

test('interrupted browser bodies do not block cookie observation or claim completed token capture', async () => {
  const security = new EvidenceSecurity();
  const context = new EventEmitter();
  await security.newContext({ newContext: async () => context }, {});
  let bodyReads = 0;
  context.emit('response', {
    headersArray: async () => [
      {
        name: 'Set-Cookie',
        value: 'session=interrupted-cookie-secret; Secure',
      },
    ],
    text: async () => {
      bodyReads++;
      throw new Error(secret);
    },
  });
  context.emit('requestfailed');
  await security.observePendingResponses();
  assert.equal(bodyReads, 0);
  assert.throws(
    () => security.assertSafe('interrupted-cookie-secret', 'logs'),
    /protected/,
  );
  const directory = await mkdtemp(join(tmpdir(), 'cc-interrupted-response-'));
  try {
    const report = await security.scan(directory);
    assert.equal(report.incompleteBrowserRequests, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('artifact path secrets never enter reports or failure messages', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cc-path-security-'));
  const marker = 'private-filename-token';
  const security = new EvidenceSecurity();
  security.register('fixture-secret', marker);
  try {
    await writeFile(join(directory, `${marker}.json`), '{}');
    await mkdir(join(directory, marker));
    await writeFile(join(directory, marker, 'safe.json'), '{}');
    await assert.rejects(
      security.scan(directory),
      (error) =>
        error.message.includes('artifact path contains a protected value') &&
        !error.message.includes(marker),
    );
    const report = await security.scan(directory);
    assert.deepEqual(report.files, []);
    assert.equal(JSON.stringify(report).includes(marker), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('browser response registration fails within its time limit for an unfinished response', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const security = new EvidenceSecurity();
  const context = new EventEmitter();
  await security.newContext({ newContext: async () => context }, {});
  context.emit('requestfinished', {
    url: () => 'https://fixture.invalid/api/auth/session',
    response: async () => ({
      url: () => 'https://fixture.invalid/api/auth/session',
      status: () => 200,
      headers: () => ({ 'content-type': 'application/json' }),
      text: async () => Promise.withResolvers().promise,
    }),
  });
  const pending = assert.rejects(
    security.observePendingResponses(),
    /exceeded its time limit/,
  );
  t.mock.timers.tick(5000);
  await pending;
});

test('browser closure drains observations and still closes after an observation failure', async () => {
  const security = new EvidenceSecurity();
  const context = new EventEmitter();
  let closed = false;
  context.close = async () => {
    closed = true;
  };
  await security.newContext({ newContext: async () => context }, {});
  const headers = Promise.withResolvers();
  context.emit('response', { headersArray: () => headers.promise });
  const closing = security.close(context);
  assert.equal(closed, false);
  headers.resolve([
    { name: 'Set-Cookie', value: 'fixture=closing-cookie-secret; Secure' },
  ]);
  await closing;
  assert.equal(closed, true);
  assert.throws(
    () => security.assertSafe('closing-cookie-secret', 'log'),
    /protected/,
  );
  closed = false;
  context.emit('response', {
    headersArray: async () => {
      throw new Error(secret);
    },
  });
  await assert.rejects(
    security.close(context),
    /registration did not complete/,
  );
  assert.equal(closed, true);
});

test('navigation response bodies stay outside token observation while their cookies remain protected', async () => {
  const security = new EvidenceSecurity();
  const context = new EventEmitter();
  await security.newContext({ newContext: async () => context }, {});
  let bodyReads = 0;
  const response = {
    url: () => 'https://fixture.invalid/api/auth/enrollment/start',
    status: () => 201,
    headersArray: async () => [
      { name: 'Set-Cookie', value: 'fixture=navigation-cookie-secret; Secure' },
    ],
    headers: () => ({ 'content-type': 'application/json' }),
    text: async () => {
      bodyReads++;
      throw new Error('No resource with given identifier found');
    },
  };
  context.emit('response', response);
  context.emit('requestfinished', {
    url: response.url,
    response: async () => response,
  });
  await security.observePendingResponses();
  assert.equal(bodyReads, 0);
  assert.throws(
    () => security.assertSafe('navigation-cookie-secret', 'log'),
    /protected/,
  );
});

test('popup closure preserves a completed token response before disposing of its page', async () => {
  for (const guarded of [false, true]) {
    const security = new EvidenceSecurity();
    const context = new EventEmitter();
    await security.newContext({ newContext: async () => context }, {});
    let closed = false;
    const page = {
      close: async () => {
        closed = true;
      },
    };
    const responseReady = Promise.withResolvers();
    context.emit('requestfinished', {
      url: () => 'https://fixture.invalid/api/auth/session',
      response: async () => {
        await responseReady.promise;
        if (closed) throw new Error('Target page has been closed');
        return {
          url: () => 'https://fixture.invalid/api/auth/session',
          status: () => 200,
          headers: () => ({ 'content-type': 'application/json' }),
          text: async () => JSON.stringify({ csrfToken: 'popup-csrf-secret' }),
        };
      },
    });
    const closing = guarded ? security.close(page) : page.close();
    assert.equal(closed, !guarded);
    responseReady.resolve();
    await closing;
    assert.equal(closed, true);
    if (guarded) {
      await security.observePendingResponses();
      assert.throws(
        () => security.assertSafe('popup-csrf-secret', 'report'),
        /protected/,
      );
    } else {
      await assert.rejects(
        security.observePendingResponses(),
        (error) =>
          JSON.parse(error.observations).failures[0].reason === 'target-closed',
      );
    }
  }
});

test('failed response diagnostics record bounded browser lifecycle fields without response details', async () => {
  const security = new EvidenceSecurity();
  const context = new EventEmitter();
  await security.newContext({ newContext: async () => context }, {});
  const page = { isClosed: () => true, close: async () => undefined };
  await security.close(page);
  const response = {
    url: () => `https://fixture.invalid/${secret}`,
    status: () => 200,
    request: () => ({
      frame: () => ({ page: () => page }),
      resourceType: () => 'font',
    }),
    headersArray: async () => {
      throw new Error(`Target closed: ${secret}`);
    },
  };
  context.emit('response', response);
  await assert.rejects(security.observePendingResponses(), (error) => {
    assert.equal(error.observations.includes(secret), false);
    assert.deepEqual(JSON.parse(error.observations).failures[0], {
      stage: 'headers',
      route: 'other',
      status: 200,
      contextId: 1,
      pageId: 1,
      resourceType: 'font',
      pageClosing: true,
      pageClosed: true,
      contextClosing: false,
      contextClosed: false,
      reason: 'target-closed',
    });
    return true;
  });
});

test('completed assets retain cookies without querying a disposed page for unused response bodies', async () => {
  const security = new EvidenceSecurity();
  const context = new EventEmitter();
  await security.newContext({ newContext: async () => context }, {});
  const page = { isClosed: () => true, close: async () => undefined };
  const request = {
    url: () => 'https://fixture.invalid/font.woff2',
    frame: () => ({ page: () => page }),
    resourceType: () => 'font',
    response: async () => {
      throw new Error('Target page has been closed');
    },
  };
  context.emit('response', {
    url: request.url,
    status: () => 200,
    request: () => request,
    headersArray: async () => [
      { name: 'Set-Cookie', value: 'asset=asset-transient-cookie; Secure' },
    ],
  });
  await security.close(page);
  context.emit('requestfinished', request);
  await security.observePendingResponses();
  assert.throws(
    () => security.assertSafe('asset-transient-cookie', 'report'),
    /protected/,
  );
});

test('guarded closure waits for an active asset response before disposing of the page', async () => {
  const security = new EvidenceSecurity();
  const context = new EventEmitter();
  await security.newContext({ newContext: async () => context }, {});
  let closed = false;
  const page = {
    isClosed: () => closed,
    close: async () => {
      closed = true;
    },
  };
  const request = {
    url: () => 'https://fixture.invalid/font.woff2',
    frame: () => ({ page: () => page }),
    resourceType: () => 'font',
  };
  context.emit('request', request);
  const closing = security.close(page);
  await new Promise((done) => setImmediate(done));
  const closedBeforeResponse = closed;
  context.emit('response', {
    url: request.url,
    status: () => 200,
    request: () => request,
    headersArray: async () => {
      if (closed) throw new Error('Target page has been closed');
      return [
        { name: 'Set-Cookie', value: 'asset=pending-font-cookie; Secure' },
      ];
    },
  });
  context.emit('requestfinished', request);
  await closing;
  assert.equal(closedBeforeResponse, false);
  assert.equal(closed, true);
  await security.observePendingResponses();
  assert.throws(
    () => security.assertSafe('pending-font-cookie', 'report'),
    /protected/,
  );
});

test('guarded closure bounds active requests and closes on timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const security = new EvidenceSecurity();
  const context = new EventEmitter();
  await security.newContext({ newContext: async () => context }, {});
  let closed = false;
  context.close = async () => {
    closed = true;
    context.emit('close');
  };
  context.emit('request', {
    url: () => `https://fixture.invalid/${secret}`,
    resourceType: () => 'fetch',
    frame: () => {
      throw new Error('Worker request');
    },
  });
  const closing = assert.rejects(security.close(context), (error) => {
    assert.match(
      error.message,
      /Browser requests did not finish before closure/,
    );
    assert.equal(error.observations.includes(secret), false);
    const observations = JSON.parse(error.observations);
    assert.equal(observations.activeRequestCount, 1);
    assert.equal(observations.activeRequests[0].route, 'other');
    assert.equal(observations.activeRequests[0].resourceType, 'fetch');
    assert.equal(observations.activeRequests[0].headersObserved, false);
    return true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  t.mock.timers.tick(5000);
  await closing;
  assert.equal(closed, true);
});

test('page closure blocks new requests without waiting for another page', async () => {
  const security = new EvidenceSecurity();
  const context = new EventEmitter();
  await security.newContext({ newContext: async () => context }, {});
  const otherPage = { isClosed: () => false };
  const request = { frame: () => ({ page: () => otherPage }) };
  context.emit('request', request);
  let blocked = false,
    closed = false;
  await security.close({
    route: async (pattern, handler) => {
      assert.equal(pattern, '**/*');
      await handler({
        abort: async () => {
          blocked = true;
        },
      });
    },
    close: async () => {
      closed = true;
    },
  });
  assert.equal(blocked, true);
  assert.equal(closed, true);
  context.emit('requestfailed', request);
});

test('browser closure drains child contexts before browser disposal', async () => {
  const security = new EvidenceSecurity();
  const context = new EventEmitter();
  await security.newContext({ newContext: async () => context }, {});
  let contextClosed = false,
    browserClosed = false;
  context.close = async () => {
    contextClosed = true;
    context.emit('close');
  };
  const request = {
    frame: () => ({ page: () => ({ isClosed: () => false }) }),
  };
  context.emit('request', request);
  const closing = security.close({
    contexts: () => [context],
    close: async () => {
      browserClosed = true;
    },
  });
  await new Promise((done) => setImmediate(done));
  assert.equal(contextClosed, false);
  assert.equal(browserClosed, false);
  context.emit('requestfailed', request);
  await closing;
  assert.equal(contextClosed, true);
  assert.equal(browserClosed, true);
});

test('page closure retires late requests that Chromium does not finish', async () => {
  for (const requestAfterClose of [false, true]) {
    const security = new EvidenceSecurity();
    const context = new EventEmitter();
    await security.newContext({ newContext: async () => context }, {});
    context.close = async () => context.emit('close');
    const page = new EventEmitter();
    let closed = false;
    page.isClosed = () => closed;
    const request = {
      frame: () => ({ page: () => page }),
      url: () => 'https://fixture.invalid/font.woff2',
      resourceType: () => 'font',
    };
    page.close = async () => {
      if (!requestAfterClose) context.emit('request', request);
      closed = true;
      page.emit('close');
      if (requestAfterClose) context.emit('request', request);
    };
    context.emit('page', page);
    await security.close(page);
    await security.close(context);
    context.emit('requestfailed', request);
    const directory = await mkdtemp(join(tmpdir(), 'cc-retired-request-'));
    try {
      assert.equal(
        (await security.scan(directory)).incompleteBrowserRequests,
        1,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    context.emit('response', {
      url: request.url,
      request: () => request,
      headersArray: async () => {
        throw new Error('Target page has been closed');
      },
    });
    await assert.rejects(
      security.observePendingResponses(),
      /Browser response secret registration did not complete/,
    );
  }
});

test('closure waits for token bodies but not unfinished non-token bodies after cookie registration', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const tokenBody of [false, true]) {
    const security = new EvidenceSecurity();
    const context = new EventEmitter();
    await security.newContext({ newContext: async () => context }, {});
    context.close = async () => context.emit('close');
    const request = {
      url: () =>
        `https://fixture.invalid/${tokenBody ? 'api/auth/session' : 'stream'}`,
      frame: () => {
        throw new Error('Worker request');
      },
    };
    context.emit('request', request);
    context.emit('response', {
      url: request.url,
      status: () => 200,
      request: () => request,
      headersArray: async () => [
        { name: 'Set-Cookie', value: 'stream=stream-response-cookie; Secure' },
      ],
    });
    const closing = security.close(context);
    const result = tokenBody
      ? assert.rejects(
          closing,
          /Browser requests did not finish before closure/,
        )
      : assert.doesNotReject(closing);
    await new Promise((done) => setImmediate(done));
    t.mock.timers.tick(5000);
    await result;
    assert.throws(
      () => security.assertSafe('stream-response-cookie', 'report'),
      /protected/,
    );
  }
});
