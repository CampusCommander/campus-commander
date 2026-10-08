import { performance } from 'node:perf_hooks';

/** Report activity without exposing command output or estimating completion. */
export async function withProgress(operation, output, initialStage) {
  const started = performance.now();
  let stage = initialStage;
  const report = () => {
    const seconds = Math.floor((performance.now() - started) / 1000);
    output(`Working: ${stage}. Elapsed: ${seconds}s.`);
  };
  report();
  const timer = setInterval(report, 5000);
  timer.unref();
  try {
    return await operation((next) => {
      stage = next;
      report();
    });
  } finally {
    clearInterval(timer);
  }
}
