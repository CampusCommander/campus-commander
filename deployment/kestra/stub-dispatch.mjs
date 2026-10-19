import http from 'node:http';
import { appendFileSync } from 'node:fs';

/**
 * Records every dispatch request that Kestra sends. The harness reads the log
 * after each execution. The script runs inside its own container on the
 * harness network, so the Kestra HTTP task can reach it by service name.
 *
 * Scenario rules:
 * - batch 0 answers 503 to its first attempt, so a retry runs.
 * - batch 1 closes the connection on its first attempt, so a retry runs.
 * - every other batch answers 200 on its first attempt, so no retry follows.
 * - every batch of the job named by STUB_FAIL_JOB answers 503, so the flow
 *   fails its retries and runs the `errors` tasks.
 */
const logPath = process.env.STUB_LOG;
const failJob = process.env.STUB_FAIL_JOB ?? '';
const attempts = new Map();

const record = (entry) => {
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
};

const server = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const startedAt = Date.now();
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
    // The flow sends the ForEach value, which Kestra renders as a string. The
    // worker contract coerces it with z.coerce.number(), as entity_sync does.
    const batch = Number(body?.batch);
    const key = `${body?.jobId}:${batch}`;
    const attempt = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, attempt);
    const send = (status, extra = {}) => {
      record({
        path: request.url,
        method: request.method,
        body,
        attempt,
        startedAt,
        endedAt: Date.now(),
        status,
        ...extra,
      });
      response.writeHead(status);
      response.end(status === 200 ? '{}' : 'stub-answer');
    };
    if (request.url === '/health') {
      send(200);
      return;
    }
    if (request.url === '/dispatch/device-update-batch') {
      if (body?.jobId === failJob) {
        send(503);
        return;
      }
      if (batch === 0 && attempt === 1) {
        send(503);
        return;
      }
      if (batch === 1 && attempt === 1) {
        record({
          path: request.url,
          method: request.method,
          body,
          attempt,
          startedAt,
          endedAt: Date.now(),
          status: 0,
          connectionClosed: true,
        });
        request.socket.destroy();
        return;
      }
    }
    send(200);
  });
});

server.listen(9000, '0.0.0.0', () => {
  process.stdout.write('stub-ready\n');
});
