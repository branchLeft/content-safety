import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

describe('the service only dials', () => {
  it('has no code path that listens for a connection', async () => {
    const files = (await readdir(SRC)).filter((name) => name.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(10);

    const offenders: string[] = [];
    for (const name of files) {
      const text = await readFile(join(SRC, name), 'utf8');
      if (/\bcreateServer\b|\.listen\(|from 'node:(http|https|http2|net|dgram|tls)'/.test(text)) offenders.push(name);
    }

    expect(offenders).toEqual([]);
  });

  it('reads the hash source credential from a file, never the environment', async () => {
    const files = (await readdir(SRC)).filter((name) => name.endsWith('.ts'));
    const offenders: string[] = [];
    for (const name of files) {
      // `main.ts` reads the name of its configuration file from the environment, which is not a secret.
      if (name === 'main.ts' || name === 'bin.ts') continue;
      if (/process\.env/.test(await readFile(join(SRC, name), 'utf8'))) offenders.push(name);
    }

    expect(offenders).toEqual([]);
  });
});
