import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditFileError, openAuditFile } from '../src/audit-file.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'content-safety-audit-hardening-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('openAuditFile on a file that already exists', () => {
  it('refuses one that is readable by group or others instead of keeping its mode', async () => {
    const path = join(dir, 'audit.jsonl');
    await writeFile(path, '{"a":1}\n');
    await chmod(path, 0o644);

    await expect(openAuditFile(path)).rejects.toBeInstanceOf(AuditFileError);
    await expect(openAuditFile(path)).rejects.toThrow('readable by group or others');
  });

  it('refuses a symbolic link', async () => {
    const target = join(dir, 'real.jsonl');
    await writeFile(target, '', { mode: 0o600 });
    const link = join(dir, 'link.jsonl');
    await symlink(target, link);

    await expect(openAuditFile(link)).rejects.toThrow();
  });

  it('starts the next record on a fresh line when the last one was torn', async () => {
    const path = join(dir, 'audit.jsonl');
    await writeFile(path, '{"complete":1}\n{"torn":', { mode: 0o600 });

    const file = await openAuditFile(path);
    await file.write('{"next":1}\n');
    await file.write('{"after":1}\n');
    await file.close();

    const lines = (await readFile(path, 'utf8')).split('\n');
    expect(lines).toEqual(['{"complete":1}', '{"torn":', '{"next":1}', '{"after":1}', '']);
    expect(JSON.parse(lines[2] ?? '')).toEqual({ next: 1 });
  });

  it('does not add a line break to a file that already ends on one', async () => {
    const path = join(dir, 'audit.jsonl');
    await writeFile(path, '{"complete":1}\n', { mode: 0o600 });

    const file = await openAuditFile(path);
    await file.write('{"next":1}\n');
    await file.close();

    expect(await readFile(path, 'utf8')).toBe('{"complete":1}\n{"next":1}\n');
  });
});

describe('openAuditFile writes in the same turn', () => {
  it('keeps every line, in order, when many are written at once', async () => {
    const path = join(dir, 'audit.jsonl');
    const file = await openAuditFile(path);
    const lines = Array.from({ length: 500 }, (_, i) => `{"n":${String(i)}}\n`);

    await Promise.all(lines.map((line) => file.write(line)));
    await file.close();

    expect(await readFile(path, 'utf8')).toBe(lines.join(''));
  });

  it('writes what is still pending when it is closed', async () => {
    const path = join(dir, 'audit.jsonl');
    const file = await openAuditFile(path);

    const pending = file.write('{"pending":1}\n');
    await file.close();
    await pending;

    expect(await readFile(path, 'utf8')).toBe('{"pending":1}\n');
  });
});
