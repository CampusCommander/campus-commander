#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

if (process.argv[2] !== '--confirm-data-loss') {
  process.stderr.write(
    'Erasure requires --confirm-data-loss. This removes every profile volume.\n',
  );
  process.exitCode = 2;
} else {
  const result = spawnSync(
    'docker',
    [
      'compose',
      '--file',
      process.argv[3] ?? 'docker-compose.yml',
      'down',
      '--volumes',
      '--remove-orphans',
    ],
    { stdio: 'inherit' },
  );
  process.exitCode = result.status ?? 1;
}
