import { execFileSync } from 'node:child_process';

/** Send operator identity input without a host-owned request mount. */
export function applicationAccess(composeFile, project, request) {
  return JSON.parse(
    execFileSync(
      'docker',
      [
        'compose',
        '-f',
        composeFile,
        '-p',
        project,
        'run',
        '--rm',
        '--no-deps',
        '--interactive',
        '--no-tty',
        'database-migrate',
        'node',
        '/app/deployment/bootstrap/application-access-cli.mjs',
        '/run/config/profile.json',
        '/run/config/operator.json',
        '/dev/stdin',
      ],
      {
        encoding: 'utf8',
        input: JSON.stringify(request),
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30000,
      },
    ),
  );
}
