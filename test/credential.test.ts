import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { basicAuthorization, readSecretFile, Secret, SecretFileError } from '../src/credential.js';

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

describe('readSecretFile keeping the edges of a password', () => {
  const EDGE = { stripLineEndingOnly: true } as const;

  async function read(content: string): Promise<string> {
    return (await readSecretFile(await fileWith(content), 'test secret', EDGE)).reveal();
  }

  async function refusalWith(content: string): Promise<string> {
    try {
      await readSecretFile(await fileWith(content), 'test secret', EDGE);
    } catch (error) {
      expect(error).toBeInstanceOf(SecretFileError);
      return (error as Error).message;
    }
    throw new Error('expected a refusal');
  }

  it('strips one trailing newline and nothing else, so a leading or trailing space survives', async () => {
    expect(await read(` ${VALUE} \n`)).toBe(` ${VALUE} `);
    expect(await read(`${VALUE}  \r\n`)).toBe(`${VALUE}  `);
    expect(await read(`  ${VALUE}`)).toBe(`  ${VALUE}`);
    expect(await read(`${VALUE}\n`)).toBe(VALUE);
  });

  it('still trims everything when no option is given, as the username does', async () => {
    expect((await readSecretFile(await fileWith(` ${VALUE} \n`), 'test secret')).reveal()).toBe(VALUE);
  });

  it('fails closed on a file that is empty once its line ending is gone', async () => {
    expect(await refusalWith('')).toContain('is empty');
    expect(await refusalWith('\n')).toContain('is empty');
    expect(await refusalWith('\r\n')).toContain('is empty');
    expect(await refusalWith('   \n')).toContain('is empty');
  });

  it('fails closed on more than one line, and never quotes the secret in the refusal', async () => {
    for (const content of [`${VALUE}\nsecond`, `${VALUE}\n\n`, `${VALUE}\r`]) {
      const message = await refusalWith(content);

      expect(message).toContain('single line');
      expect(message).not.toContain(VALUE);
    }
  });

  it('hands the password on intact, so the header carries every space', async () => {
    const password = await readSecretFile(await fileWith(` ${VALUE} \n`), 'test secret', EDGE);

    const header = basicAuthorization(new Secret('TEST_SENTINEL_USER'), password);

    expect(Buffer.from(header.reveal().slice('Basic '.length), 'base64').toString('utf8')).toBe(`TEST_SENTINEL_USER: ${VALUE} `);
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

describe('basicAuthorization', () => {
  const USER = 'TEST_SENTINEL_USER';
  const PASS = 'TEST_SENTINEL_PASS:with-colon';

  function refusalOf(user: string, pass: string): string {
    try {
      basicAuthorization(new Secret(user), new Secret(pass));
    } catch (error) {
      expect(error).toBeInstanceOf(SecretFileError);
      return (error as Error).message;
    }
    throw new Error('expected a refusal');
  }

  it('joins the pair as RFC 7617 does, keeping a colon inside the password', () => {
    const header = basicAuthorization(new Secret(USER), new Secret(PASS));

    expect(header.reveal()).toBe(`Basic ${Buffer.from(`${USER}:${PASS}`, 'utf8').toString('base64')}`);
    expect(Buffer.from(header.reveal().slice('Basic '.length), 'base64').toString('utf8')).toBe(`${USER}:${PASS}`);
  });

  it('encodes a non-ASCII half as UTF-8', () => {
    const header = basicAuthorization(new Secret('usér'), new Secret('pässword'));

    expect(Buffer.from(header.reveal().slice('Basic '.length), 'base64').toString('utf8')).toBe('usér:pässword');
  });

  it('returns a value that logs and serialises as a placeholder', () => {
    const header = basicAuthorization(new Secret(USER), new Secret(PASS));

    for (const shown of [String(header), JSON.stringify({ header }), inspect(header)]) {
      expect(shown).not.toContain('Basic');
      expect(shown).not.toContain(USER);
    }
  });

  it('refuses a username that holds a colon, which would move the split, and never quotes either half', () => {
    const message = refusalOf(`${USER}:more`, PASS);

    expect(message).toContain('hash source username');
    expect(message).not.toContain(USER);
    expect(message).not.toContain(PASS);
  });

  it('refuses an empty half and any control character in either half', () => {
    expect(refusalOf('', PASS)).toContain('hash source username');
    expect(refusalOf(USER, '')).toContain('hash source password');
    expect(refusalOf(`${USER}\tx`, PASS)).toContain('hash source username');
    expect(refusalOf(USER, `${PASS}\u007f`)).toContain('hash source password');
  });
});
