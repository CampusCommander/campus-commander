const fs = require('node:fs');
const { createRequire } = require('node:module');
const requireApplication = createRequire(`${process.cwd()}/package.json`);
const { JWT } = requireApplication('google-auth-library');
const { Pool } = requireApplication('pg');
const root = '/run/qualification-observation';
const held = () => {
  try {
    return (
      JSON.parse(fs.readFileSync(`${root}/hold.json`, 'utf8')).hold === true
    );
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
};
const record = (name) => {
  const path = `${root}/${name}.json`;
  const temporary = `${path}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ observed: true }), {
    mode: 0o600,
  });
  fs.renameSync(temporary, path);
};
const query = Pool.prototype.query;
Pool.prototype.query = function (...args) {
  const result = query.apply(this, args);
  if (args[0] !== 'SELECT cc.acquire_google_access($1,$2,$3) AS result')
    return result;
  return result.then((value) => {
    if (held() && value.rows[0]?.result?.status === 'pending')
      record('pending');
    return value;
  });
};
const transport = Object.getPrototypeOf(new JWT().transporter);
const request = transport.request;
transport.request = async function (options) {
  const url = new URL(options.url);
  if (
    url.hostname === 'oauth2.googleapis.com' &&
    url.pathname === '/token' &&
    held()
  ) {
    record('renewal-started');
    const started = Date.now();
    while (held()) {
      if (Date.now() - started >= 10000)
        throw new Error('The fixture renewal barrier timed out.');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  return request.call(this, options);
};
