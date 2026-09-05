// Throwaway process used to expose the external-result persistence gap.
import { createRequire } from 'node:module';
const require = createRequire(`${process.env.V0_NODE_MODULES || '/tmp/campus-v0-lab/node/node_modules'}/loader.cjs`);
const { Client } = require('pg');
const db = new Client({ host: '127.0.0.1', port: 55439, user: process.env.USER, database: 'v0_validation' });
await db.connect();
await db.query("INSERT INTO v0.provider_effects VALUES (900001, 'accepted remotely')");
process.send('provider accepted before local outcome commit');
setInterval(() => {}, 1000);
