import { createHash } from 'node:crypto';
import { readdir, readFile, rm } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const secretFields = new Set([
  'csrfToken',
  'token',
  'browserToken',
  'private_key',
  'client_secret',
  'access_token',
  'refresh_token',
  'id_token',
]);

export class EvidenceSecurity {
  #markers = new Map();
  #counts = new Map();
  #screenshots = new Map();

  register(category, value) {
    if (typeof value !== 'string' && !Buffer.isBuffer(value)) return;
    const bytes = Buffer.from(value);
    if (bytes.length < 8) return;
    const key = digest(bytes);
    if (this.#markers.has(key)) return;
    const variants = [
      bytes,
      Buffer.from(bytes.toString('base64')),
      Buffer.from(bytes.toString('hex')),
    ];
    if (typeof value === 'string') {
      variants.push(
        Buffer.from(JSON.stringify(value).slice(1, -1)),
        Buffer.from(encodeURIComponent(value)),
      );
    }
    this.#markers.set(key, { category, variants });
    this.#counts.set(category, (this.#counts.get(category) ?? 0) + 1);
  }

  observeResponse(headers, text) {
    const cookies = headers['set-cookie'] ?? [];
    for (const cookie of typeof cookies === 'string' ? [cookies] : cookies) {
      const pair = cookie.split(';')[0];
      this.register('browser-cookie', pair.slice(pair.indexOf('=') + 1));
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return;
    }
    const visit = (value) => {
      if (!value || typeof value !== 'object') return;
      for (const [key, nested] of Object.entries(value)) {
        if (secretFields.has(key)) this.register('response-secret', nested);
        else visit(nested);
      }
    };
    visit(body);
    if (typeof body?.code === 'string' && /^[a-f0-9]{64}$/.test(body.code))
      this.register('pairing-code', body.code);
  }

  assertSafe(value, label) {
    const bytes = Buffer.from(value);
    for (const { category, variants } of this.#markers.values()) {
      if (variants.some((marker) => bytes.includes(marker))) {
        throw new Error(`${label} contains a protected ${category} value.`);
      }
    }
    if (
      /-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----/.test(
        bytes.toString('utf8'),
      )
    ) {
      throw new Error(`${label} contains private key material.`);
    }
  }

  async assertPageSafe(page, label) {
    for (const cookie of await page.context().cookies())
      this.register('browser-cookie', cookie.value);
    const content = await page.evaluate(() =>
      [
        document.documentElement.outerHTML,
        document.body.innerText,
        ...Array.from(
          document.querySelectorAll(
            'input:not([type="password"]):not([type="file"]),textarea',
          ),
          (field) => field.value,
        ),
      ].join('\n'),
    );
    this.assertSafe(content, label);
  }

  async screenshot(page, options) {
    const path = resolve(options.path);
    try {
      await this.assertPageSafe(page, basename(path));
      const bytes = await page.screenshot(options);
      await this.assertPageSafe(page, basename(path));
      this.assertSafe(bytes, basename(path));
      this.#screenshots.set(path, digest(bytes));
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    }
  }

  async scan(directory, sources = {}) {
    const files = [];
    const findings = [];
    for (const [label, value] of Object.entries(sources)) {
      try {
        this.assertSafe(value, label);
      } catch (error) {
        findings.push(error.message);
      }
    }
    const walk = async (path) => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const file = join(path, entry.name);
        if (entry.isDirectory()) {
          await walk(file);
          continue;
        }
        if (!entry.isFile())
          throw new Error('Evidence must contain regular files only.');
        const bytes = await readFile(file);
        try {
          if (!['.json', '.png'].includes(extname(entry.name)))
            throw new Error(
              `${entry.name} uses an unsupported evidence format.`,
            );
          this.assertSafe(bytes, entry.name);
          if (
            entry.name.endsWith('.png') &&
            this.#screenshots.get(resolve(file)) !== digest(bytes)
          ) {
            throw new Error(
              `${entry.name} lacks a matching screenshot content check.`,
            );
          }
          files.push({
            name: file.slice(resolve(directory).length + 1),
            sha256: digest(bytes),
          });
        } catch (error) {
          findings.push(error.message);
          await rm(file);
        }
      }
    };
    await walk(resolve(directory));
    if (findings.length)
      throw new Error(`Evidence redaction failed: ${findings.join(' ')}`);
    return {
      schemaVersion: 1,
      status: 'passed',
      secretCategories: Object.fromEntries(this.#counts),
      scannedSources: Object.keys(sources),
      files,
      screenshotChecks: this.#screenshots.size,
      limits: [
        'This report covers registered complete fixture secrets in the listed files and supplied logs. Partial secrets require separate review.',
        'Screenshot checks inspect surrounding document content and bind the result to exact image bytes. They do not perform image recognition.',
        'Failed runs, release bundles, and live district data require separate review.',
      ],
    };
  }
}

export const evidenceSecurity = new EvidenceSecurity();
