import { execFile } from 'node:child_process';
import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * Remove a mock-backed review environment after the review process stops.
 *
 * A task runner can end the review process without its teardown, for example
 * when the terminal closes. The review process starts this supervisor in a new
 * session. The supervisor holds the container names, the network, and the run
 * directory. It waits for the review process to stop, then removes each one.
 *
 * Usage: node api-e2e/client-review-mock-supervisor.mjs <spec.json>
 */
const logPath = join(tmpdir(), 'cc-review-supervisor.log');
const log = (line) =>
  appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const docker = (...args) =>
  new Promise((resolve) => execFile('docker', args, () => resolve()));

/** True while the review process refreshes its heartbeat. */
function reviewAlive() {
  try {
    return Date.now() - statSync(spec.heartbeatFile).mtimeMs < 8000;
  } catch {
    return false;
  }
}

/** True while a process with the recorded review process ID holds it. */
function reviewProcessRunning() {
  try {
    process.kill(spec.pid, 0);
    return true;
  } catch {
    return false;
  }
}

log(
  `waiting for review process ${spec.pid} with ${spec.containers.length} containers`,
);
for (;;) {
  await delay(2000);
  // A stopped process stops refreshing its heartbeat. Both checks hold before
  // the supervisor removes anything.
  if (reviewProcessRunning() || reviewAlive()) continue;
  log('the review process stopped without a teardown');
  await Promise.all(spec.containers.map((name) => docker('rm', '-f', name)));
  await rm(spec.directory, { recursive: true, force: true });
  await docker('network', 'rm', spec.network);
  log(`removed ${spec.containers.join(', ')} and ${spec.directory}`);
  break;
}
