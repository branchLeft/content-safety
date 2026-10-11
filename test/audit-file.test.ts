import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openAuditFile } from '../src/audit-file.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'content-safety-audit-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('openAuditFile', () => {
  it('appends lines in order, to an owner-only file, and keeps what an earlier run wrote', async () => {
    const path = join(dir, 'audit.jsonl');
    await writeFile(path, 'EARLIER_LINE\n', { mode: 0o600 });

    const file = await openAuditFile(path);
    await Promise.all([file.write('one\n'), file.write('two\n'), file.write('three\n')]);
    await file.close();

    expect(await readFile(path, 'utf8')).toBe('EARLIER_LINE\none\ntwo\nthree\n');
  });

  it('creates the file readable by its owner only', async () => {
    const path = join(dir, 'new.jsonl');

    const file = await openAuditFile(path);
    await file.close();

    expect(((await stat(path)).mode & 0o777).toString(8)).toBe('600');
  });

  it('fails the write that failed and not the ones after it', async () => {
    const file = await openAuditFile(join(dir, 'audit.jsonl'));
    const huge = { toString: () => { throw new Error('bad line'); } } as unknown as string;

    await expect(file.write(huge)).rejects.toThrow();
    await file.write('after\n');
    await file.close();

    expect(await readFile(join(dir, 'audit.jsonl'), 'utf8')).toBe('after\n');
  });

  it('refuses a path it cannot open', async () => {
    await expect(openAuditFile(join(dir, 'absent-directory', 'audit.jsonl'))).rejects.toThrow();
  });
});
