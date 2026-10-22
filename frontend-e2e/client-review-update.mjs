#!/usr/bin/env node
/**
 * Run the Update device completion checks against the production-U6 review runtime.
 *
 * The command starts `api-e2e:client-review-mock` when no review environment is running,
 * waits for its runtime record, then runs `frontend-e2e/src/device-update-u6-review.spec.ts`
 * with the main Playwright configuration and the Chromium project. Neither the API nor the
 * device stream is intercepted: preview, targets, confirmation, the durable job, the worker,
 * settlement, the device stream, and the inventory read are the application's own paths.
 * Google stays simulated by the Admin SDK mock.
 *
 * The command stops the review environment that it started and removes its containers.
 * It leaves an environment that it found running.
 *
 * Environment:
 * - `CC_REVIEW_URL` uses a running review environment instead of starting one.
 * - `CC_MOCK_TIER` picks the mock tier for a new environment (default `small`).
 * - `CC_MOCK_DELAYS` keeps or removes the modeled Google latency (default `off`).
 * - `EVIDENCE_DIR` sets where the spec saves its screenshots.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const runtimeFile = path.join(root, 'dist/client-review/runtime.json');
const logFile = path.join(root, 'dist/client-review/update-run.log');
const spec = 'src/device-update-u6-review.spec.ts';
const evidenceDir =
  process.env.EVIDENCE_DIR ?? path.join(root, 'dist/e2e-evidence/u6-review');
const nx = path.join(root, 'node_modules/nx/dist/bin/nx.js');

/** One review runtime record, as `api-e2e:client-review-mock` writes it. */
async function readRuntime() {
  const value = JSON.parse(await readFile(runtimeFile, 'utf8'));
  if (value.googleServices !== 'admin-sdk-mock')
    throw new Error(
      `${runtimeFile} names ${value.googleServices}; client-review-mock is required.`,
    );
  return value;
}

/** Answer whether an origin serves the application health route. */
function reachable(url) {
  return new Promise((resolve) => {
    const target = new URL('/api/application', url);
    const call = request(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'GET',
        rejectUnauthorized: false,
        timeout: 4000,
      },
      (response) => {
        response.resume();
        resolve(response.statusCode !== undefined);
      },
    );
    call.on('error', () => resolve(false));
    call.on('timeout', () => {
      call.destroy();
      resolve(false);
    });
    call.end();
  });
}

async function waitForRuntime(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(runtimeFile)) {
      try {
        const value = await readRuntime();
        if (value.url) return value;
      } catch {
        // The harness writes the file once; a partial read means it is still starting.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `The review environment did not report a runtime within ${Math.round(
      timeoutMs / 1000,
    )} seconds. See ${logFile}.`,
  );
}

/** Stop one child, and report whether it ended. */
function stop(child, timeoutMs = 180_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
    child.kill('SIGTERM');
  });
}

function run(args, environment) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [nx, ...args], {
      cwd: root,
      env: environment,
      stdio: 'inherit',
    });
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

/** Containers this run's environment owns. Another project's containers stay untouched. */
function reviewContainers() {
  const result = spawnSync('docker', ['ps', '--format', '{{.Names}}'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) return [];
  return result.stdout
    .split('\n')
    .map((name) => name.trim())
    .filter((name) => name.startsWith('cc-phase2-'));
}

let review = null;
let exitCode = 1;
try {
  await mkdir(path.dirname(logFile), { recursive: true });
  await mkdir(evidenceDir, { recursive: true });

  let runtime;
  if (process.env.CC_REVIEW_URL) {
    const url = process.env.CC_REVIEW_URL;
    if (!(await reachable(url)))
      throw new Error(`${url} does not answer /api/application.`);
    runtime = { url };
    process.stdout.write(`Using the running review environment at ${url}.\n`);
  } else if (
    existsSync(runtimeFile) &&
    (await reachable((await readRuntime()).url))
  ) {
    runtime = await readRuntime();
    process.stdout.write(
      `Using the running review environment at ${runtime.url}.\n`,
    );
  } else {
    const output = [];
    review = spawn(
      process.execPath,
      [nx, 'run', 'api-e2e:client-review-mock', '--skip-nx-cache'],
      {
        cwd: root,
        env: {
          ...process.env,
          CC_MOCK_TIER: process.env.CC_MOCK_TIER ?? 'small',
          CC_MOCK_DELAYS: process.env.CC_MOCK_DELAYS ?? 'off',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const collect = (bytes) => {
      output.push(bytes.toString());
      process.stdout.write(bytes);
    };
    review.stdout.on('data', collect);
    review.stderr.on('data', collect);
    process.stdout.write('Starting the review environment…\n');
    runtime = await waitForRuntime(900_000);
    await writeFile(logFile, output.join(''), 'utf8');
    process.stdout.write(
      `Client review: ${runtime.url} · ${runtime.googleBackend ?? 'admin-sdk-mock'} · ${runtime.tier ?? 'unknown'} · ${runtime.deviceCount ?? '?'} devices\n`,
    );
  }

  exitCode = await run(
    [
      'run',
      'frontend-e2e:e2e',
      '--skip-nx-cache',
      // The review runtime serves the built frontend; no dev server is needed.
      '--excludeTaskDependencies',
      `--args=${spec} --project=chromium --workers=1 --retries=0`,
    ],
    {
      ...process.env,
      BASE_URL: runtime.url,
      CC_U6_REVIEW: '1',
      EVIDENCE_DIR: evidenceDir,
    },
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  exitCode = 1;
} finally {
  if (review) {
    const stopped = await stop(review);
    if (!stopped)
      process.stderr.write(
        'The review environment did not stop within 180 seconds.\n',
      );
    const leftover = reviewContainers();
    if (leftover.length) {
      process.stderr.write(
        `Review containers remain: ${leftover.join(', ')}. Remove them with docker rm -f.\n`,
      );
      if (exitCode === 0) exitCode = 1;
    }
  }
  process.stdout.write(
    exitCode === 0
      ? `Update device completion checks passed. Screenshots: ${evidenceDir}\n`
      : 'Update device completion checks failed.\n',
  );
  process.exit(exitCode);
}
