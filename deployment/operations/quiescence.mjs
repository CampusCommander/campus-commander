export const connectionQuiescenceTimeoutMilliseconds = 5000;

/** Observe connection teardown without accepting a stale statistics snapshot. */
export async function noOtherConnections(
  client,
  {
    now = () => performance.now(),
    delay = (milliseconds) =>
      new Promise((done) => setTimeout(done, milliseconds)),
  } = {},
) {
  const deadline = now() + connectionQuiescenceTimeoutMilliseconds;
  for (;;) {
    await client.query('SELECT pg_stat_clear_snapshot()');
    const result = await client.query(
      'SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()',
    );
    if (result.rows[0].count === 0) return;
    const remaining = deadline - now();
    if (remaining <= 0)
      throw new Error(
        'Stop every application and Kestra database connection before backup or restore.',
      );
    await delay(Math.min(100, remaining));
  }
}
