// Disposable browser smoke test. The fixture edits synthetic in-memory rows.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFile, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
const require = createRequire(`${process.cwd()}/package.json`);
const { build } = require('esbuild');
const { chromium } = require('playwright');
const lab = '/tmp/campus-v0-lab/grid';
await writeFile(`${lab}/browser-entry.js`, "import '@angular/compiler';\nimport './output/fixture.js';\n");
await build({ entryPoints: [`${lab}/browser-entry.js`], bundle: true, outfile: `${lab}/browser.js`, platform: 'browser', format: 'esm' });
const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>V0 grid fixture</title><style>ag-grid-angular{display:block;height:400px;width:850px}</style></head><body><v0-grid></v0-grid><script type="module" src="/browser.js"></script></body></html>';
const server = createServer(async (req, res) => {
  if (req.url === '/browser.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    res.end(await readFile(`${lab}/browser.js`));
  } else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html); }
});
await new Promise(resolve => server.listen(58289, '127.0.0.1', resolve));
let browser;
const errors = [], messages = [], checks = [];
let failure;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.V0_BROWSER_EXECUTABLE });
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (['warning', 'error'].includes(message.type())) messages.push({ type: message.type(), text: message.text() }); });
  await page.goto('http://127.0.0.1:58289');
  await page.locator('.ag-row [col-id="serial"]').filter({ hasText: 'TEST001' }).waitFor({ timeout: 15000 });
  checks.push('Server-side datasource rendered the synthetic device');
  const cell = page.locator('.ag-row [col-id="location"]').filter({ hasText: 'Library' });
  await cell.dblclick();
  const editor = page.locator('.ag-cell-inline-editing input');
  await editor.fill('Updated library');
  await editor.press('Enter');
  assert.equal(await page.locator('.ag-row [col-id="location"]').innerText(), 'Updated library');
  checks.push('Editable cell accepted and displayed a synthetic value');
  const checkbox = page.locator('.ag-row .ag-selection-checkbox input');
  await checkbox.check({timeout: 2000});
  assert.equal(await page.locator('.ag-row').getAttribute('aria-selected'), 'true');
  checks.push('Row selection updated the accessible selected state');
  assert.deepEqual(errors, []);
} catch (error) { failure = error.message; }
finally {
  const result = { date: new Date().toISOString(), result: failure ? 'FAIL' : 'PASS', browser: browser ? browser.version() : null, checks, errors, messages, failure,
    limits: ['One synthetic row in Chromium', 'Uses Angular JIT support for dependency linking in the disposable bundle', 'No production bundle, row eviction, draft persistence, screen-reader study, or capacity qualification'] };
  await writeFile(new URL('../evidence/grid-browser.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
if (failure) process.exitCode = 1;
