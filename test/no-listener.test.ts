import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

// A listener, or any import that could make one, by quoted specifier in any
// of the forms a module can take it: with or without the `node:` prefix.
const LISTENER =
  /\bcreateServer\b|\.listen\(|(?:\bfrom|\bimport\s*\(|\brequire\s*\()\s*['"`](?:node:)?(?:http|https|http2|net|dgram|tls|cluster)['"`]/;

describe('the listener pattern', () => {
  it('matches every form of taking a network module, and none of the look-alikes', () => {
    for (const sample of [
      "import http from 'http';",
      "import { createServer } from 'node:http';",
      "import tls from \"tls\";",
      "const net = require('net');",
      'const dgram = await import("node:dgram");',
      'server.listen(8080);',
    ]) {
      expect(LISTENER.test(sample), sample).toBe(true);
    }
    for (const sample of [
      "import { x } from './http-thing.js';",
      "import { readFile } from 'node:fs/promises';",
      "const word = 'net';",
      'Nothing here listens.',
    ]) {
      expect(LISTENER.test(sample), sample).toBe(false);
    }
  });
});

describe('the service only dials', () => {
  it('has no code path that listens for a connection', async () => {
    const files = (await readdir(SRC)).filter((name) => name.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(10);

    const offenders: string[] = [];
    for (const name of files) {
      if (LISTENER.test(await readFile(join(SRC, name), 'utf8'))) offenders.push(name);
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
