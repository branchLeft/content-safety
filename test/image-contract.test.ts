import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DOCKERFILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'Dockerfile');

const SECRET_NAME = /KEY|SECRET|TOKEN|CRED|PASS/i;

// Everything the image may copy in: the manifests, the compiler settings and
// the source. Config, credential, key and audit files are bind-mounted at run
// time, so a path that names any of them is a defect, not an omission.
const COPYABLE = /^(?:\.\/)?(?:package(?:-lock)?\.json|tsconfig(?:\.build)?\.json|src\/?|dist\/?)$/;

interface Instruction {
  readonly name: string;
  readonly args: string;
}

/** Joins continuation lines, drops comments and blank lines. */
function instructions(dockerfile: string): readonly Instruction[] {
  const out: Instruction[] = [];
  let pending = '';
  for (const raw of dockerfile.split('\n')) {
    const line = raw.trim();
    if (pending === '' && (line === '' || line.startsWith('#'))) continue;
    if (pending !== '' && line.startsWith('#')) continue;
    const joined = pending + line;
    if (joined.endsWith('\\')) {
      pending = joined.slice(0, -1) + ' ';
      continue;
    }
    pending = '';
    const space = joined.search(/\s/);
    out.push(
      space === -1
        ? { name: joined.toUpperCase(), args: '' }
        : { name: joined.slice(0, space).toUpperCase(), args: joined.slice(space).trim() }
    );
  }
  return out;
}

function copySources(args: string): readonly string[] {
  const words = args
    .replace(/[[\],"]/g, ' ')
    .split(/\s+/)
    .filter((word) => word !== '' && !word.startsWith('--'));
  return words.slice(0, -1);
}

/** Every way a Dockerfile can break the image's contract; empty when it keeps it. */
export function violations(dockerfile: string): readonly string[] {
  const found: string[] = [];
  const all = instructions(dockerfile);

  if (all.some((i) => i.name === 'EXPOSE')) found.push('EXPOSE: the service only dials, it has no listener');

  const users = all.filter((i) => i.name === 'USER').map((i) => i.args.split(':')[0] ?? '');
  const last = users[users.length - 1];
  if (last === undefined || last === 'root' || last === '0') found.push('USER: the image must end as a non-root user');

  for (const i of all.filter((x) => x.name === 'ENV' || x.name === 'ARG')) {
    const name = (i.args.split(/[\s=]/)[0] ?? '').trim();
    if (SECRET_NAME.test(name)) found.push(`${i.name} ${name}: a secret-shaped name can leak into a layer`);
  }

  for (const i of all.filter((x) => x.name === 'COPY' || x.name === 'ADD')) {
    for (const source of copySources(i.args)) {
      if (!COPYABLE.test(source)) found.push(`${i.name} ${source}: not on the list of things the image may copy`);
    }
  }

  const cmds = all.filter((i) => i.name === 'CMD');
  const exact = cmds.length === 1 && cmds[0]?.args.replace(/\s+/g, '') === '["node","dist/bin.js"]';
  if (!exact) found.push('CMD: must be exactly ["node", "dist/bin.js"]');

  return found;
}

const GOOD = `# syntax=docker/dockerfile:1
FROM node:26.5.0-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=node_auth_token \\
    sh -eu -c 'npm ci'
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build
USER node
CMD ["node", "dist/bin.js"]
`;

describe('the contract checker', () => {
  it('accepts a conforming Dockerfile', () => {
    expect(violations(GOOD)).toEqual([]);
  });

  it('rejects each way of breaking the contract, and only that', () => {
    const cases: readonly (readonly [string, string, RegExp])[] = [
      ['a listener', GOOD.replace('USER node', 'EXPOSE 8080\nUSER node'), /^EXPOSE/],
      ['no user', GOOD.replace('USER node\n', ''), /^USER/],
      ['root user', GOOD.replace('USER node', 'USER root'), /^USER/],
      ['root by number after node', GOOD.replace('USER node', 'USER node\nUSER 0'), /^USER/],
      ['a secret-shaped ENV', GOOD.replace('USER node', 'ENV API_TOKEN=x\nUSER node'), /^ENV API_TOKEN/],
      ['a secret-shaped ARG', GOOD.replace('USER node', 'ARG DB_PASSWORD\nUSER node'), /^ARG DB_PASSWORD/],
      ['a credential file copied in', GOOD.replace('COPY src ./src', 'COPY src credential.txt ./'), /^COPY credential\.txt/],
      ['the whole context copied in', GOOD.replace('COPY src ./src', 'COPY . .'), /^COPY \./],
      ['a key file added', GOOD.replace('COPY src ./src', 'ADD signing.key /etc/'), /^ADD signing\.key/],
      ['another command', GOOD.replace('"dist/bin.js"', '"dist/other.js"'), /^CMD/],
      ['no command', GOOD.replace(/CMD .*\n/, ''), /^CMD/],
      ['two commands', `${GOOD}CMD ["node", "dist/bin.js"]\n`, /^CMD/],
    ];
    for (const [label, dockerfile, expected] of cases) {
      const found = violations(dockerfile);
      expect(found.length, label).toBe(1);
      expect(found[0], label).toMatch(expected);
    }
  });

  it('reads a continued line as one instruction', () => {
    expect(violations(GOOD.replace('COPY src ./src', 'COPY src \\\n  credential.txt ./'))).toHaveLength(1);
  });

  it('ignores a comment that mentions a forbidden word', () => {
    expect(violations(`# EXPOSE 8080, ENV TOKEN=x\n${GOOD}`)).toEqual([]);
  });
});

describe('the Dockerfile', () => {
  it('keeps the image contract', async () => {
    expect(violations(await readFile(DOCKERFILE, 'utf8'))).toEqual([]);
  });
});
