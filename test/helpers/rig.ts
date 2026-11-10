import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig, type ServiceConfig } from '../../src/config.js';
import { startService, type RunningService } from '../../src/service-runner.js';
import { makeSigningKey, type TestSigningKey } from './keys.js';
import { startStandInHost, type StandInHost } from './stand-in-host.js';
import { startStubArachnid, type StubArachnid, type StubEntry } from './stub-arachnid.js';

/** Recognisable stand-ins for the pair: nothing real, easy to search for. The password holds a colon on purpose. */
export const SENTINEL_USERNAME = 'TEST_SENTINEL_USER_0123456789';
export const SENTINEL_PASSWORD = 'TEST_SENTINEL_PASS_0123:456789';
/** What the hash source must be shown for the pair above (RFC 7617). */
export const SENTINEL_AUTHORIZATION = `Basic ${Buffer.from(`${SENTINEL_USERNAME}:${SENTINEL_PASSWORD}`, 'utf8').toString('base64')}`;

export interface RigOptions {
  readonly listed?: Map<string, StubEntry>;
  readonly arachnidTimeoutMs?: number;
  readonly hostKind?: 'demo' | 'tenant';
  readonly username?: string;
  readonly password?: string;
  readonly key?: TestSigningKey;
  readonly hostKey?: TestSigningKey;
  readonly holdMs?: number;
}

export interface Rig {
  readonly dir: string;
  readonly host: StandInHost;
  readonly arachnid: StubArachnid;
  readonly config: ServiceConfig;
  readonly logs: string[];
  readonly auditPath: string;
  readonly usernamePath: string;
  readonly passwordPath: string;
  readonly keyPath: string;
  start(): Promise<RunningService>;
  auditLines(): Promise<string[]>;
  dispose(): Promise<void>;
}

export async function startRig(options: RigOptions = {}): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), 'content-safety-rig-'));
  const key = options.key ?? makeSigningKey();
  const hostKey = options.hostKey ?? key;
  const arachnid = await startStubArachnid(options.listed ?? new Map());
  const host = await startStandInHost({ publicKey: hostKey.publicKey, ...(options.holdMs === undefined ? {} : { holdMs: options.holdMs }) });

  const usernamePath = join(dir, 'username');
  const passwordPath = join(dir, 'password');
  const keyPath = join(dir, 'signing-key');
  const auditPath = join(dir, 'audit.jsonl');
  await writeFile(usernamePath, `${options.username ?? SENTINEL_USERNAME}\n`, { mode: 0o600 });
  await writeFile(passwordPath, `${options.password ?? SENTINEL_PASSWORD}\n`, { mode: 0o600 });
  await writeFile(keyPath, `${key.seedBase64}\n`, { mode: 0o600 });
  await chmod(usernamePath, 0o600);
  await chmod(passwordPath, 0o600);
  await chmod(keyPath, 0o600);

  const config = parseConfig({
    arachnid: {
      baseUrl: arachnid.baseUrl,
      usernameFile: usernamePath,
      passwordFile: passwordPath,
      timeoutMs: options.arachnidTimeoutMs ?? 300,
    },
    channel: {
      signingKeyFile: keyPath,
      pollTimeoutMs: 2000,
      postTimeoutMs: 2000,
      minPollGapMs: 5,
      backoffBaseMs: 10,
      backoffMaxMs: 50,
    },
    cache: { negativeTtlMs: 60_000 },
    audit: { file: auditPath },
    shutdownGraceMs: 1000,
    hosts: [
      {
        id: 'HOST_A',
        kind: options.hostKind ?? 'demo',
        safety: { near: true, exact: true },
        endpoint: host.endpoint,
      },
    ],
  });

  const logs: string[] = [];
  const running: RunningService[] = [];
  return {
    dir,
    host,
    arachnid,
    config,
    logs,
    auditPath,
    usernamePath,
    passwordPath,
    keyPath,
    async start(): Promise<RunningService> {
      const service = await startService(config, {
        log: (event, fields) => logs.push(JSON.stringify({ event, ...fields })),
      });
      running.push(service);
      return service;
    },
    async auditLines(): Promise<string[]> {
      const text = await readFile(auditPath, 'utf8').catch(() => '');
      return text.split('\n').filter((line) => line.length > 0);
    },
    async dispose(): Promise<void> {
      for (const service of running) await service.stop();
      await host.close();
      await arachnid.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
