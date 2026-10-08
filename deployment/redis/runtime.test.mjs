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
    '~cc:* &cc:* -@all +ping +get +getdel +mget +set +del +exists +expire +ttl +eval +llen +lrange +rpush +zadd +zrem +zremrangebyscore +time +subscribe +unsubscribe',
  );
  assert.equal(
    workerRedisAcl,
    '~cc:entity:* ~cc:query-gen:* ~cc:entity-inflight:* &cc:entity-events:* -@all +ping +set +del +publish +incr +zadd +zrem +multi +exec',
  );
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
