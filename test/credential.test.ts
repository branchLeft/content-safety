import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSecretFile, Secret, SecretFileError } from '../src/credential.js';

const VALUE = 'TEST_SENTINEL_VALUE_ABCDEF';
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'content-safety-secret-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function fileWith(content: string, mode = 0o600): Promise<string> {
  const path = join(dir, 'secret');
  await writeFile(path, content);
  await chmod(path, mode);
  return path;
}

async function refusal(path: string): Promise<string> {
  try {
    await readSecretFile(path, 'test secret');
  } catch (error) {
    expect(error).toBeInstanceOf(SecretFileError);
    return (error as Error).message;
  }
  throw new Error('expected a refusal');
}

describe('Secret', () => {
  it('yields only a placeholder when stringified, serialised or inspected', () => {
    const secret = new Secret(VALUE);

    expect(`${String(secret)}`).not.toContain(VALUE);
    expect(JSON.stringify({ secret })).not.toContain(VALUE);
    expect(inspect(secret)).not.toContain(VALUE);
    expect(inspect({ nested: { secret } }, { depth: 5 })).not.toContain(VALUE);
    expect(secret.reveal()).toBe(VALUE);
  });
});

describe('readSecretFile', () => {
  it('reads the one line in an owner-only file, without its trailing newline', async () => {
    const secret = await readSecretFile(await fileWith(`${VALUE}\n`), 'test secret');

    expect(secret.reveal()).toBe(VALUE);
  });

  it('refuses a path that is not configured, missing, or not a file', async () => {
    expect(await refusal('')).toContain('no file path is configured');
    expect(await refusal(join(dir, 'absent'))).toContain('cannot be read');
    expect(await refusal(dir)).toContain('not a regular file');
  });

  it('refuses an empty file and a multi-line file', async () => {
    expect(await refusal(await fileWith('  \n'))).toContain('is empty');
    expect(await refusal(await fileWith(`${VALUE}\nsecond`))).toContain('single line');
  });

  it('refuses a file readable by group or others, and never quotes what is in it', async () => {
    const message = await refusal(await fileWith(`${VALUE}\n`, 0o644));

    expect(message).toContain('readable by group or others');
    expect(message).not.toContain(VALUE);
  });

  it('refuses a file that exists but cannot be opened', async () => {
    const path = await fileWith(`${VALUE}\n`, 0o600);
    await chmod(path, 0o000);
    // Ownership gives no right to read a file with no mode bits, except to root.
    const isRoot = process.getuid?.() === 0;
    if (isRoot) return;
    expect(await refusal(path)).toContain('cannot be read');
  });
});

describe('readSecretFile and a path that is not the file itself', () => {
  it('refuses a symbolic link, even to an owner-only file', async () => {
    const target = join(dir, 'real-secret');
    await writeFile(target, `${VALUE}\n`);
    await chmod(target, 0o600);
    const link = join(dir, 'link-to-secret');
    await symlink(target, link);

    const message = await refusal(link);

    expect(message).toContain('symbolic link');
    expect(message).not.toContain(VALUE);
  });
});
