import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export class ProofError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export async function readPrivateFile(path) {
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0) {
      throw new ProofError('private-file-permissions');
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function writePrivateFile(path, contents) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(12).toString('hex')}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
    const directory = await open(dirname(path), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await handle.close();
    await rm(temporary, { force: true });
  }
}

// This file store belongs to the proof. Production credentials belong in PostgreSQL.
export class CredentialStore {
  constructor(credentialPath, keyPath) {
    if (resolve(credentialPath) === resolve(keyPath)) {
      throw new ProofError('separate-key-required');
    }
    this.credentialPath = credentialPath;
    this.keyPath = keyPath;
  }

  async initializeKey() {
    await mkdir(dirname(this.keyPath), { recursive: true, mode: 0o700 });
    try {
      const handle = await open(this.keyPath, 'wx', 0o600);
      try {
        await handle.writeFile(randomBytes(32));
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw new ProofError('key-unavailable');
    }
    await this.key();
  }

  async key() {
    try {
      const key = await readPrivateFile(this.keyPath);
      if (key.length !== 32) throw new Error();
      return key;
    } catch {
      throw new ProofError('key-unavailable');
    }
  }

  async read() {
    const key = await this.key();
    try {
      const envelope = JSON.parse(await readPrivateFile(this.credentialPath));
      if (envelope.format !== 1) throw new Error();
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(envelope.iv, 'base64url'),
      );
      decipher.setAAD(Buffer.from('campus-commander:google-proof:1'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
      const value = JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
          decipher.final(),
        ]),
      );
      if (!Number.isSafeInteger(value.version) || value.version < 1)
        throw new Error();
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new ProofError('credential-unavailable');
    }
  }

  async locked(action) {
    await mkdir(dirname(this.credentialPath), { recursive: true, mode: 0o700 });
    let lock;
    const lockPath = `${this.credentialPath}.lock`;
    try {
      lock = await open(lockPath, 'wx', 0o600);
    } catch {
      throw new ProofError('credential-busy');
    }
    try {
      return await action(await this.read(), async (value) => {
        const key = await this.key();
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, iv);
        cipher.setAAD(Buffer.from('campus-commander:google-proof:1'));
        const ciphertext = Buffer.concat([
          cipher.update(JSON.stringify(value)),
          cipher.final(),
        ]);
        await writePrivateFile(
          this.credentialPath,
          JSON.stringify({
            format: 1,
            iv: iv.toString('base64url'),
            tag: cipher.getAuthTag().toString('base64url'),
            ciphertext: ciphertext.toString('base64url'),
          }),
        );
      });
    } finally {
      await lock.close();
      await rm(lockPath);
    }
  }

  async replace(expectedVersion, value) {
    return this.locked(async (current, save) => {
      if ((current?.version ?? 0) !== expectedVersion)
        throw new ProofError('credential-conflict');
      if (current && current.customerId !== value.customerId)
        throw new ProofError('wrong-customer');
      const next = { ...value, version: expectedVersion + 1 };
      await save(next);
      return next;
    });
  }
}
