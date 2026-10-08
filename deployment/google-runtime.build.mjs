import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

await build({
  absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
  entryPoints: ['deployment/operations/google-runtime.entry.mjs'],
  outfile: 'dist/deployment/google-runtime.mjs',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  external: ['google-auth-library', 'zod'],
  tsconfig: 'tsconfig.base.json',
});
