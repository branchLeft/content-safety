import { chmod, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONFIG_ENV, runMain } from '../src/main.js';
import { hashOf } from './helpers/fixtures.js';
import { SENTINEL_CREDENTIAL, startRig, type Rig } from './helpers/rig.js';

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

  it('refuses to start with no credential file configured, and says which setting', async () => {
    rig = await startRig();
    const path = await configFile(rig, (c) => delete c.arachnid.credentialFile);
    const run = io();

    expect(await runMain(['--config', path], {}, run.api)).toBe(1);
    expect(run.lines.join('\n')).toContain('arachnid.credentialFile');
    expect(rig.host.requests).toHaveLength(0);
    expect(rig.arachnid.requests).toHaveLength(0);
  });

  it('refuses to start when the credential file is missing, empty or open to others, without quoting it', async () => {
    rig = await startRig();
    const path = await configFile(rig);

    const cases: [() => Promise<void>, string][] = [
      [() => rm(rig!.credentialPath), 'cannot be read'],
      [() => writeFile(rig!.credentialPath, '\n', { mode: 0o600 }), 'is empty'],
      [
        async () => {
          await writeFile(rig!.credentialPath, `${SENTINEL_CREDENTIAL}\n`);
          await chmod(rig!.credentialPath, 0o644);
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
      expect(output).not.toContain('TEST_SENTINEL_CREDENTIAL');
    }
    expect(rig.host.requests).toHaveLength(0);
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
    expect(run.lines.join('\n')).not.toContain('TEST_SENTINEL_CREDENTIAL');
  });
});
