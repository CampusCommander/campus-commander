import { readFile } from 'node:fs/promises';
import { createBootstrapEdge, stopOnSignals } from './edge.mjs';

/**
 * Run the edge as a separate process for the stop-path test, so the test sends a real
 * SIGTERM. The stop wiring is the same call that main.mjs makes.
 */
const config = JSON.parse(await readFile(process.env.CC_CONFIG_FILE, 'utf8'));
const resolveSecret = (reference) =>
  readFile(
    reference.path.endsWith('private-key')
      ? process.env.CC_EDGE_KEY_FILE
      : process.env.CC_EDGE_CERT_FILE,
  );
const server = await createBootstrapEdge({
  config,
  verify: async () => false,
  resolveSecret,
});
const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('Invalid edge port.');
// A connection that has not started its TLS handshake has no other observable signal. Report
// acceptance, so the stop test signals the process only after the server holds the transport.
server.on('connection', () => process.stdout.write('connection accepted\n'));
server.listen(port, '127.0.0.1', () => process.stdout.write('edge ready\n'));
stopOnSignals(server);
