// Disposable compiler qualification outside the application dependency tree.
import { copyFile, writeFile, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const lab = '/tmp/campus-v0-lab/grid';
await copyFile(new URL('grid-fixture.ts', import.meta.url), `${lab}/fixture.ts`);
const configuration = {
  compilerOptions: {
    target: 'ES2022', module: 'ES2022', moduleResolution: 'bundler',
    lib: ['ES2022', 'DOM'], strict: true, skipLibCheck: false,
    experimentalDecorators: true, outDir: './output', types: [],
  },
  angularCompilerOptions: { strictTemplates: true },
  files: ['./fixture.ts'],
};
await writeFile(`${lab}/tsconfig.json`, JSON.stringify(configuration, null, 2));
const child = spawnSync(`${lab}/node_modules/.bin/ngc`, ['-p', `${lab}/tsconfig.json`], { encoding: 'utf8' });
const result = {
  date: new Date().toISOString(), result: child.status === 0 ? 'PASS' : 'FAIL',
  packages: JSON.parse(await readFile(`${lab}/package.json`, 'utf8')).dependencies,
  compilerConfiguration: configuration, stdout: child.stdout, stderr: child.stderr,
  limits: ['Angular AOT and template compilation only', 'No browser rendering, runtime feature, accessibility, or capacity proof'],
};
await writeFile(new URL('../evidence/grid-compiler.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
process.exitCode = child.status ?? 1;
