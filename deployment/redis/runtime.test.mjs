import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  applicationRedisAcl,
  renderRedis,
  workerRedisAcl,
} from './runtime.mjs';

test('the application and worker users get only the commands they issue', () => {
  assert.equal(
    applicationRedisAcl,
    '~cc:* &cc:* -@all +ping +get +getdel +mget +set +del +exists +expire +ttl +eval +llen +lrange +rpush +zadd +zrem +zremrangebyscore +time +subscribe +unsubscribe +publish +incr',
  );
  assert.equal(
    workerRedisAcl,
    '~cc:entity:* ~cc:query-gen:* ~cc:entity-inflight:* &cc:entity-events:* &cc:job-events:* -@all +ping +set +del +publish +incr +zadd +zrem +multi +exec',
  );
});

test('the worker publishes job events but cannot write the admission hold', () => {
  const keyPatterns = workerRedisAcl
    .split(' ')
    .filter((rule) => rule.startsWith('~'));
  const channelPatterns = workerRedisAcl
    .split(' ')
    .filter((rule) => rule.startsWith('&'));
  // The hold belongs to the API. A worker key pattern for it would let a
  // worker renew or delete a hold (design sections 3.2 and 6.2).
  assert.equal(
    keyPatterns.some((pattern) => pattern.startsWith('~cc:job-hold:')),
    false,
  );
  assert.deepEqual(channelPatterns, [
    '&cc:entity-events:*',
    '&cc:job-events:*',
  ]);
  // The API grants report backoff and publish job events.
  assert.match(applicationRedisAcl, / \+publish(?: |$)/);
  assert.match(applicationRedisAcl, / \+incr(?: |$)/);
});

test('renderRedis gives the worker user the same password hash', async () => {
  const password = Buffer.from('synthetic-credential-marker-32-bytes');
  const hash = createHash('sha256').update(password).digest('hex');
  const config = JSON.parse(
    await readFile(
      new URL('../examples/all-docker.json', import.meta.url),
      'utf8',
    ),
  );
  const rendered = renderRedis(config, password);
  assert.ok(rendered.includes(`user worker on #${hash} ${workerRedisAcl}`));
});
