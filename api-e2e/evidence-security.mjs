import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const secretFields = new Set([
  'csrfToken',
  'csrf',
  'token',
  'browserToken',
  'private_key',
  'client_secret',
  'access_token',
  'refresh_token',
  'id_token',
]);
const tokenBodyPaths = new Set([
  '/api/auth/session',
  '/pair',
  '/api/auth/invitations',
]);

export function captureEvidenceOutput(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error('Evidence process did not complete successfully.');
  return `${result.stdout}\n${result.stderr}`;
}

export class EvidenceSecurity {
  #markers = new Map();
  #counts = new Map();
  #screenshots = new Map();
  #pending = new Map();
  #responseFailures = 0;
  #incompleteResponses = 0;
  #failureStages = { headers: 0, body: 0 };
  #failedResponses = [];
  #contextSequence = 0;
  #pageSequence = 0;
  #pageIds = new WeakMap();
  #closing = new WeakSet();
  #requests = new Map();

  async newContext(browser, options) {
    const context = await browser.newContext(options);
    const contextId = ++this.#contextSequence;
    context.on('page', (page) => {
      this.#pageIds.set(page, ++this.#pageSequence);
    });
    let contextClosed = false;
    context.on('close', () => {
      contextClosed = true;
      for (const [request, active] of this.#requests)
        if (active.context === context) this.#finishRequest(request);
    });
    context.on('request', (request) => {
      let page;
      try {
        page = request.frame().page();
      } catch {
        // Worker requests belong to the context.
      }
      const finished = Promise.withResolvers();
      const active = {
        context,
        page,
        finished,
        headersObserved: false,
        describe: () => ({
          ...stateFor(
            { url: () => request.url?.() ?? 'http://fixture.invalid/' },
            'request',
          ),
          ...lifecycle(request),
          headersObserved: active.headersObserved,
        }),
      };
      this.#requests.set(request, active);
    });
    const lifecycle = (request) => {
      let page;
      try {
        page = request?.frame?.().page();
      } catch {
        // Worker requests do not have a page.
      }
      if (page && !this.#pageIds.has(page))
        this.#pageIds.set(page, ++this.#pageSequence);
      const type = request?.resourceType?.();
      return {
        contextId,
        pageId: page ? this.#pageIds.get(page) : null,
        resourceType: [
          'document',
          'stylesheet',
          'image',
          'media',
          'font',
          'script',
          'xhr',
          'fetch',
          'eventsource',
          'websocket',
          'manifest',
        ].includes(type)
          ? type
          : 'other',
        pageClosing: page ? this.#closing.has(page) : false,
        pageClosed: page?.isClosed() ?? null,
        contextClosing: this.#closing.has(context),
        contextClosed,
      };
    };
    const stateFor = (response, stage) => {
      const paths = new Set([
        '/pair',
        '/import',
        '/api/auth/session',
        '/api/auth/preferences',
        '/api/auth/invitations',
        '/api/application',
        '/api/auth/login',
        '/api/auth/callback',
        '/api/auth/enrollment/start',
        '/api/auth/enrollment/status',
      ]);
      const path = new URL(response.url?.() ?? 'http://fixture.invalid/')
        .pathname;
      return {
        stage,
        route: paths.has(path) ? path : 'other',
        status: response.status?.() ?? 0,
      };
    };
    const observe = (state, operation, request) => {
      const observation = operation().catch((error) => {
        this.#responseFailures++;
        this.#failureStages[state.stage]++;
        if (this.#failedResponses.length < 32)
          this.#failedResponses.push({
            ...state,
            ...lifecycle(request),
            reason: /closed/i.test(error.message)
              ? 'target-closed'
              : /redirect/i.test(error.message)
                ? 'redirect-body-unavailable'
                : /No resource|No data found/i.test(error.message)
                  ? 'body-unavailable'
                  : /Protocol error/i.test(error.message)
                    ? 'protocol-failure'
                    : 'unclassified',
          });
      });
      this.#pending.set(observation, state);
      void observation.then(() => this.#pending.delete(observation));
    };
    context.on('response', (response) => {
      const request = response.request?.();
      const active = this.#requests.get(request);
      const state = stateFor(response, 'headers');
      observe(
        state,
        async () => {
          const headers = await response.headersArray();
          this.observeResponse(
            {
              'set-cookie': headers
                .filter(({ name }) => name.toLowerCase() === 'set-cookie')
                .map(({ value }) => value),
            },
            '',
          );
          if (active) {
            active.headersObserved = true;
            if (!tokenBodyPaths.has(state.route)) this.#finishRequest(request);
          }
        },
        response.request?.(),
      );
    });
    context.on('requestfinished', (request) => {
      this.#finishRequest(request);
      const path = new URL(request.url()).pathname;
      if (!tokenBodyPaths.has(path)) return;
      const state = { stage: 'body', route: 'other', status: 0 };
      observe(
        state,
        async () => {
          const response = await request.response();
          if (response) Object.assign(state, stateFor(response, 'body'));
          const tokenResponse =
            (state.route === '/api/auth/session' && state.status === 200) ||
            (state.route === '/pair' && state.status === 200) ||
            (state.route === '/api/auth/invitations' &&
              state.status === 201 &&
              request.method() === 'POST');
          if (
            tokenResponse &&
            response.headers()['content-type']?.includes('application/json')
          )
            this.observeResponse({}, await response.text());
        },
        request,
      );
    });
    context.on('requestfailed', (request) => {
      this.#finishRequest(request);
      this.#incompleteResponses++;
    });
    return context;
  }

  async close(resource) {
    this.#closing.add(resource);
    try {
      if (typeof resource.contexts === 'function') {
        const results = await Promise.allSettled(
          resource.contexts().map((context) => this.close(context)),
        );
        const failure = results.find(({ status }) => status === 'rejected');
        if (failure) throw failure.reason;
      } else {
        await resource.route?.('**/*', (route) => route.abort());
        await this.#finishResourceRequests(resource);
      }
      await this.observePendingResponses();
    } finally {
      await resource.close();
    }
  }

  #finishRequest(request) {
    const active = this.#requests.get(request);
    this.#requests.delete(request);
    active?.finished.resolve();
  }

  async #finishResourceRequests(resource) {
    let timer;
    try {
      await Promise.race([
        (async () => {
          for (;;) {
            const active = [...this.#requests.values()].filter(
              ({ page, context }) => page === resource || context === resource,
            );
            if (!active.length) return;
            await Promise.all(active.map(({ finished }) => finished.promise));
          }
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                this.#observationError(
                  'Browser requests did not finish before closure.',
                ),
              ),
            5000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  #observationError(message) {
    const error = new Error(message);
    error.observations = JSON.stringify({
      pending: [...this.#pending.values()].slice(0, 32),
      failures: this.#failedResponses,
      activeRequestCount: this.#requests.size,
      activeRequests: [...this.#requests.values()]
        .slice(0, 32)
        .map(({ describe }) => describe()),
    });
    return error;
  }

  async observePendingResponses() {
    let timer;
    try {
      await Promise.race([
        (async () => {
          while (this.#pending.size) await Promise.all(this.#pending.keys());
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                this.#observationError(
                  'Browser response secret registration exceeded its time limit.',
                ),
              ),
            5000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (this.#responseFailures)
      throw this.#observationError(
        'Browser response secret registration did not complete.',
      );
  }

  register(category, value) {
    if (typeof value !== 'string' && !Buffer.isBuffer(value)) return;
    const bytes = Buffer.from(value);
    if (bytes.length < 8) return;
    const key = digest(bytes);
    if (this.#markers.has(key)) return;
    const variants = [
      bytes,
      Buffer.from(bytes.toString('base64')),
      Buffer.from(bytes.toString('hex')),
    ];
    if (typeof value === 'string') {
      variants.push(
        Buffer.from(JSON.stringify(value).slice(1, -1)),
        Buffer.from(encodeURIComponent(value)),
      );
    }
    this.#markers.set(key, { category, variants });
    this.#counts.set(category, (this.#counts.get(category) ?? 0) + 1);
  }

  observeResponse(headers, text) {
    const cookies = headers['set-cookie'] ?? [];
    for (const cookie of typeof cookies === 'string' ? [cookies] : cookies) {
      const pair = cookie.split(';')[0];
      this.register('browser-cookie', pair.slice(pair.indexOf('=') + 1));
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return;
    }
    const visit = (value) => {
      if (!value || typeof value !== 'object') return;
      for (const [key, nested] of Object.entries(value)) {
        if (secretFields.has(key)) this.register('response-secret', nested);
        else visit(nested);
      }
    };
    visit(body);
    if (typeof body?.code === 'string' && /^[a-f0-9]{64}$/.test(body.code))
      this.register('pairing-code', body.code);
  }

  assertSafe(value, label) {
    const bytes = Buffer.from(value);
    for (const { category, variants } of this.#markers.values()) {
      if (variants.some((marker) => bytes.includes(marker))) {
        throw new Error(`${label} contains a protected ${category} value.`);
      }
    }
    if (
      /-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----/.test(
        bytes.toString('utf8'),
      )
    ) {
      throw new Error(`${label} contains private key material.`);
    }
  }

  async assertPageSafe(page, label) {
    await this.observePendingResponses();
    for (const cookie of await page.context().cookies())
      this.register('browser-cookie', cookie.value);
    const content = await page.evaluate(() =>
      [
        document.documentElement.outerHTML,
        document.body.innerText,
        ...Array.from(
          document.querySelectorAll(
            'input:not([type="password"]):not([type="file"]),textarea',
          ),
          (field) => field.value,
        ),
      ].join('\n'),
    );
    this.assertSafe(content, label);
  }

  async screenshot(page, options) {
    const path = resolve(options.path);
    this.assertSafe(path, 'screenshot path');
    try {
      await this.assertPageSafe(page, basename(path));
      const bytes = await page.screenshot(options);
      await this.assertPageSafe(page, basename(path));
      this.assertSafe(bytes, basename(path));
      this.#screenshots.set(path, digest(bytes));
    } catch (error) {
      await rm(path, { force: true });
      await writeFile(
        `${path}.redaction-failure.json`,
        JSON.stringify(
          {
            status: 'failed',
            pendingResponses: this.#pending.size,
            pendingStages: [...this.#pending.values()].slice(0, 32),
            responseFailures: this.#failureStages,
            failedResponses: this.#failedResponses,
            reason:
              error.message ===
              'Browser response secret registration did not complete.'
                ? 'response-observation-failed'
                : error.message ===
                    'Browser response secret registration exceeded its time limit.'
                  ? 'response-observation-timeout'
                  : 'screenshot-content-check-failed',
          },
          null,
          2,
        ),
      );
      throw error;
    }
  }

  async scan(directory, sources = {}) {
    await this.observePendingResponses();
    const files = [];
    const findings = [];
    for (const [label, value] of Object.entries(sources)) {
      try {
        this.assertSafe(value, label);
      } catch (error) {
        findings.push(error.message);
      }
    }
    const walk = async (path) => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const file = join(path, entry.name);
        try {
          this.assertSafe(
            file.slice(resolve(directory).length + 1),
            'artifact path',
          );
        } catch {
          findings.push('An artifact path contains a protected value.');
          await rm(file, { recursive: true, force: true });
          continue;
        }
        if (entry.isDirectory()) {
          await walk(file);
          continue;
        }
        if (!entry.isFile()) {
          findings.push('Evidence must contain regular files only.');
          await rm(file, { force: true });
          continue;
        }
        const bytes = await readFile(file);
        try {
          if (!['.json', '.png'].includes(extname(entry.name)))
            throw new Error(
              `${entry.name} uses an unsupported evidence format.`,
            );
          this.assertSafe(bytes, entry.name);
          if (
            entry.name.endsWith('.png') &&
            this.#screenshots.get(resolve(file)) !== digest(bytes)
          ) {
            throw new Error(
              `${entry.name} lacks a matching screenshot content check.`,
            );
          }
          files.push({
            name: file.slice(resolve(directory).length + 1),
            sha256: digest(bytes),
          });
        } catch (error) {
          findings.push(error.message);
          await rm(file);
        }
      }
    };
    await walk(resolve(directory));
    if (findings.length)
      throw new Error(`Evidence redaction failed: ${findings.join(' ')}`);
    return {
      schemaVersion: 1,
      status: 'passed',
      secretCategories: Object.fromEntries(this.#counts),
      scannedSources: Object.keys(sources),
      files,
      screenshotChecks: this.#screenshots.size,
      incompleteBrowserRequests: this.#incompleteResponses,
      limits: [
        'This report covers registered complete fixture secrets in the listed files and supplied logs. Partial secrets require separate review.',
        'Screenshot checks inspect surrounding document content and bind the result to exact image bytes. They do not perform image recognition.',
        'Browser JSON token observation covers successful session, invitation creation, and setup pairing responses. All browser responses retain cookie observation.',
        'Failed runs, release bundles, and live district data require separate review.',
      ],
    };
  }
}

export const evidenceSecurity = new EvidenceSecurity();
