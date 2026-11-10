import { chmod, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONFIG_ENV, runMain } from '../src/main.js';
import { hashOf } from './helpers/fixtures.js';
import { SENTINEL_PASSWORD, SENTINEL_USERNAME, startRig, type Rig } from './helpers/rig.js';

let rig: Rig | undefined;

afterEach(async () => {
  await rig?.dispose();
  rig = undefined;
});

function io(autoStopMs = 400): { lines: string[]; stop: () => void; api: Parameters<typeof runMain>[2] } {
  const lines: string[] = [];
  let stop: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
    // A process that should have refused to start would otherwise wait for
    // a stop signal for ever; stopping it here turns that into exit code 0.
    if (autoStopMs > 0) setTimeout(resolve, autoStopMs).unref();
  });
  return { lines, stop, api: { write: (line) => lines.push(line), waitForStop: () => stopped } };
}

async function configFile(r: Rig, change?: (config: Record<string, any>) => void): Promise<string> {
  const config = JSON.parse(JSON.stringify(r.config)) as Record<string, any>;
  change?.(config);
  const path = join(r.dir, 'service.json');
  await writeFile(path, JSON.stringify(config));
  return path;
}

describe('runMain', () => {
  it('refuses to start with no configuration named', async () => {
    const run = io();

    expect(await runMain([], {}, run.api)).toBe(2);
    expect(await runMain(['--config'], {}, run.api)).toBe(2);
    expect(await runMain([], { [CONFIG_ENV]: '' }, run.api)).toBe(2);
    expect(run.lines.join('\n')).toContain('refused-to-start');
  });

  it('refuses to start with either half of the pair not configured, and says which setting', async () => {
    rig = await startRig();
    for (const setting of ['usernameFile', 'passwordFile', 'credentialFile']) {
      const path = await configFile(rig, (c) => {
        if (setting === 'credentialFile') c.arachnid.credentialFile = c.arachnid.usernameFile;
        else delete c.arachnid[setting];
      });
      const run = io();

      expect(await runMain(['--config', path], {}, run.api)).toBe(1);
      // An old single-value setting is refused as unknown, not quietly ignored.
      expect(run.lines.join('\n')).toContain(setting === 'credentialFile' ? 'arachnid has an unknown key' : `arachnid.${setting}`);
    }
    expect(rig.host.requests).toHaveLength(0);
    expect(rig.arachnid.requests).toHaveLength(0);
  });

  it('refuses to start when either file is missing, empty or open to others, without quoting the pair', async () => {
    rig = await startRig();
    const path = await configFile(rig);

    for (const [target, label] of [
      [rig.usernamePath, 'hash source username'],
      [rig.passwordPath, 'hash source password'],
    ] as const) {
      const cases: [() => Promise<void>, string][] = [
        [() => rm(target), 'cannot be read'],
        [() => writeFile(target, '\n', { mode: 0o600 }), 'is empty'],
        [
          async () => {
            await writeFile(target, `${SENTINEL_USERNAME}\n`);
            await chmod(target, 0o644);
          },
          'readable by group or others',
        ],
      ];
      for (const [arrange, expected] of cases) {
        await arrange();
        const run = io();

        expect(await runMain(['--config', path], {}, run.api)).toBe(1);

        const output = run.lines.join('\n');
        expect(output).toContain(expected);
        expect(output).toContain(label);
        expect(output).not.toContain('TEST_SENTINEL_USER');
        expect(output).not.toContain('TEST_SENTINEL_PASS');
      }
      // Put it back, so the other half is the only thing wrong next time round.
      await writeFile(target, `${target === rig.usernamePath ? SENTINEL_USERNAME : SENTINEL_PASSWORD}\n`, { mode: 0o600 });
      await chmod(target, 0o600);
    }
    expect(rig.host.requests).toHaveLength(0);
  });

  it('refuses to start on a username that cannot be one half of a Basic pair, without quoting it', async () => {
    rig = await startRig();
    await writeFile(rig.usernamePath, 'TEST_SENTINEL_USER:with-colon\n', { mode: 0o600 });
    const run = io();

    expect(await runMain(['--config', await configFile(rig)], {}, run.api)).toBe(1);

    expect(run.lines.join('\n')).toContain('hash source username');
    expect(run.lines.join('\n')).not.toContain('TEST_SENTINEL_USER');
    expect(rig.arachnid.requests).toHaveLength(0);
  });

  it('refuses to start on a signing key that is not a key, and names only its class otherwise', async () => {
    rig = await startRig();
    await writeFile(rig.keyPath, 'not-a-key\n', { mode: 0o600 });
    const run = io();

    expect(await runMain(['--config', await configFile(rig)], {}, run.api)).toBe(1);

    expect(run.lines.join('\n')).toContain('exactly 32 bytes');
  });

  it('names an unexpected failure by class only', async () => {
    rig = await startRig();
    const run = io();
    const bad = await configFile(rig, (c) => (c.audit.file = join(rig!.dir, 'absent-directory', 'audit.jsonl')));

    expect(await runMain(['--config', bad], {}, run.api)).toBe(1);

    const [line] = run.lines;
    expect(JSON.parse(line ?? '{}')).toMatchObject({ event: 'refused-to-start', reason: 'Error' });
  });

  it('starts from the flag or the environment, serves a verdict, and stops cleanly', async () => {
    rig = await startRig();
    const path = await configFile(rig);
    const run = io(0);

    const exit = runMain([], { [CONFIG_ENV]: path }, { ...run.api, now: () => new Date('2026-01-01T00:00:00Z') });
    const verdict = await rig.host.submit(hashOf(1));
    // The caller is answered before the channel logs that it answered.
    await vi.waitFor(() => expect(run.lines.join('\n')).toContain('batch-answered'));
    run.stop();

    expect(await exit).toBe(0);
    expect(verdict.classification).toBe('no-known-match');
    const events = run.lines.map((line) => (JSON.parse(line) as { event: string }).event);
    expect(events).toContain('started');
    expect(events).toContain('batch-answered');
    expect(events.slice(-2)).toEqual(['stopping', 'stopped']);
    expect(JSON.parse(run.lines[0] ?? '{}')).toMatchObject({ at: '2026-01-01T00:00:00.000Z', event: 'started', hosts: 1 });
    expect(run.lines.join('\n')).not.toContain('TEST_SENTINEL_USER');
    expect(run.lines.join('\n')).not.toContain('TEST_SENTINEL_PASS');
  });
});

describe('runMain and the audit file', () => {
  it('refuses to start on an audit file that is open to others, and says so', async () => {
    rig = await startRig();
    await writeFile(rig.auditPath, '', { mode: 0o644 });
    await chmod(rig.auditPath, 0o644);
    const run = io();

    expect(await runMain(['--config', await configFile(rig)], {}, run.api)).toBe(1);

    expect(run.lines.join('\n')).toContain('readable by group or others');
    expect(rig.host.requests).toHaveLength(0);
  });
});
