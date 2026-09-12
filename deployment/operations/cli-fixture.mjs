import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { secretPath } from '../redis/runtime.mjs';

const execute = promisify(execFile);
const cliPath = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const workspace = fileURLToPath(new URL('../../', import.meta.url));
const postgresImage = JSON.parse(
  await readFile(
    new URL('../postgres/qualification.json', import.meta.url),
    'utf8',
  ),
).image;

/** Exercise the operator CLI with private serialized inputs and native tools. */
export async function createOperationsCliFixture(
  directory,
  resolveSecret,
  {
    container = false,
    mountedSecrets = false,
    mountDirectories = [directory],
  } = {},
) {
  await mkdir(directory, { mode: 0o700 });
  const secretDirectory = join(directory, 'secrets');
  await mkdir(secretDirectory, { mode: 0o700 });
  const commands = [];
  let sequence = 0;
  const materialize = async (value) => {
    if (!value || typeof value !== 'object') return value;
    if (value.provider === 'file' || value.provider === 'kubernetes') {
      if (mountedSecrets) return value;
      const secret = resolve(secretPath(value));
      if (!secret.startsWith('/run/secrets/'))
        throw new Error('Fixture secrets require the configured secret mount.');
      const path = join(secretDirectory, relative('/run/secrets', secret));
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, await resolveSecret(value), { mode: 0o600 });
      return value;
    }
    if (Array.isArray(value)) return Promise.all(value.map(materialize));
    const result = {};
    for (const [key, item] of Object.entries(value))
      result[key] = await materialize(item);
    return result;
  };
  const invoke = async (command, path) => {
    const containerName = `cc-operator-cli-${randomUUID()}`;
    try {
      const { stdout } = await execute(
        container ? 'docker' : mountedSecrets ? process.execPath : 'unshare',
        container
          ? [
              'run',
              '--rm',
              '--name',
              containerName,
              '--network',
              'host',
              '--user',
              `${process.getuid()}:${process.getgid()}`,
              '--read-only',
              '--tmpfs',
              '/tmp',
              '--mount',
              `type=bind,source=${process.execPath},target=/fixture-node,readonly`,
              '--mount',
              `type=bind,source=${workspace},target=${workspace},readonly`,
              ...mountDirectories.flatMap((source) => [
                '--mount',
                `type=bind,source=${source},target=${source}`,
              ]),
              '--mount',
              `type=bind,source=${secretDirectory},target=/run/secrets,readonly`,
              '--workdir',
              workspace,
              '--entrypoint',
              '/fixture-node',
              postgresImage,
              cliPath,
              command,
              path,
            ]
          : mountedSecrets
            ? [cliPath, command, path]
            : [
                '--user',
                '--map-root-user',
                '--mount',
                'sh',
                '-eu',
                '-c',
                'mount --make-rprivate /\n' +
                  'mount -t tmpfs tmpfs /run\n' +
                  'mkdir /run/secrets\n' +
                  'mount --bind "$1" /run/secrets\n' +
                  'mount -o remount,bind,ro /run/secrets\n' +
                  'shift\n' +
                  'exec "$@"',
                'phase-2-operator-cli',
                secretDirectory,
                process.execPath,
                cliPath,
                command,
                path,
              ],
        {
          timeout: 240000,
          maxBuffer: 1024 * 1024,
        },
      );
      commands.push({ command, status: 'passed' });
      return stdout;
    } catch (error) {
      commands.push({ command, status: 'rejected' });
      if (container) {
        try {
          await execute('docker', ['rm', '-f', '-v', containerName]);
        } catch (cleanupError) {
          if (!String(cleanupError.stderr).includes('No such container'))
            throw cleanupError;
        }
      }
      throw error;
    }
  };
  return {
    commands,
    execution: {
      runner: container
        ? 'operator-container-native'
        : mountedSecrets
          ? 'operator-native-existing-mount'
          : 'operator-host-native',
      ...(container ? { postgresImage } : {}),
      nodeVersion: process.version,
      secretMount: '/run/secrets',
      injectedDatabaseTool: false,
    },
    async generateKey() {
      const path = join(directory, 'generated-recovery-key');
      await invoke('generate-key', path);
      return readFile(path);
    },
    async run(command, { config, targetConfig, release, ...input }) {
      const id = ++sequence;
      const operator = await materialize(input);
      const configuration = await materialize(config ?? targetConfig);
      if (configuration) {
        operator.configurationPath = join(
          directory,
          `configuration-${id}.json`,
        );
        await writeFile(
          operator.configurationPath,
          JSON.stringify(configuration),
          { mode: 0o600 },
        );
      }
      if (release) {
        operator.releaseInventoryPath = join(directory, `release-${id}.json`);
        await writeFile(
          operator.releaseInventoryPath,
          JSON.stringify(release),
          { mode: 0o600 },
        );
      }
      const path = join(directory, `operator-${id}.json`);
      await writeFile(path, JSON.stringify(operator), { mode: 0o600 });
      const result = JSON.parse(await invoke(command, path));
      return { result, configuration };
    },
  };
}
