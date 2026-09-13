import assert from 'node:assert/strict';
import test from 'node:test';
import { withProgress } from './progress.mjs';

for (const fails of [false, true]) {
  test(`progress reports pending work and clears its timer after ${fails ? 'failure' : 'success'}`, async (t) => {
    let tick;
    const timer = { unref: () => undefined };
    t.mock.method(globalThis, 'setInterval', (callback, milliseconds) => {
      assert.equal(milliseconds, 5000);
      tick = callback;
      return timer;
    });
    const clear = t.mock.method(globalThis, 'clearInterval', (value) => {
      assert.equal(value, timer);
    });
    let finish;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    const output = [];
    const failure = new Error('sensitive-command-output');
    const result = withProgress(
      async (stage) => {
        stage('Starting services');
        await pending;
        if (fails) throw failure;
        return { status: 'ready' };
      },
      (line) => output.push(line),
      'Checking configuration',
    );
    assert.match(output[0], /Checking configuration.*Elapsed: \d+s/);
    tick();
    tick();
    assert.equal(output.length, 4);
    assert.match(output.at(-1), /Starting services.*Elapsed: \d+s/);
    assert.equal(clear.mock.callCount(), 0);
    finish();
    if (fails) await assert.rejects(result, (error) => error === failure);
    else assert.deepEqual(await result, { status: 'ready' });
    assert.equal(clear.mock.callCount(), 1);
    assert.doesNotMatch(
      output.join('\n'),
      /sensitive-command-output|100%|ready/,
    );
  });
}
