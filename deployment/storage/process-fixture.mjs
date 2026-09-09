import pg from 'pg';
import { createArtifactStore } from './index.mjs';

const {
  connection,
  root,
  backend,
  manifest,
  bytes,
  prefix,
  action,
  descriptor,
} = JSON.parse(process.env.CC_STORAGE_FIXTURE);
const pool = new pg.Pool(connection);
if (action === 'publish') {
  const interruptedPool = {
    async connect() {
      const client = await pool.connect();
      return {
        release: () => client.release(),
        async query(sql, values) {
          const result = await client.query(sql, values);
          if (
            typeof sql === 'string' &&
            sql.includes("SET publication_state='ready'")
          )
            process.exit(73);
          return result;
        },
      };
    },
  };
  const store = await createArtifactStore({
    pool: interruptedPool,
    root,
    backend,
  });
  await store.publish(descriptor);
} else {
  const store = await createArtifactStore({ pool, root, backend });
  await store.stage(
    manifest,
    (async function* () {
      yield Buffer.from(bytes, 'base64').subarray(0, prefix);
      process.exit(73);
    })(),
  );
}
