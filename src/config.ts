import { readFile } from 'node:fs/promises';
import type { SafetySpec, TenantKind } from '@branchleft/ghost-platform-render-core';
import { MAX_NEGATIVE_TTL_MS } from './verdict-cache.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface HostConfig {
  readonly id: string;
  readonly kind: TenantKind;
  readonly safety: SafetySpec;
  /** The origin the service dials. Never a path, never credentials in the URL. */
  readonly endpoint: string;
}

export interface ServiceConfig {
  readonly arachnid: {
    readonly baseUrl: string;
    /** A path. The file holds the whole Authorization header value, read once and never logged. */
    readonly credentialFile: string;
    readonly timeoutMs: number;
    readonly maxBatchSize?: number;
  };
  readonly channel: {
    /** A path. The file holds the base64 of the 32-byte Ed25519 seed that signs requests to hosts. */
    readonly signingKeyFile: string;
    readonly pollTimeoutMs: number;
    readonly postTimeoutMs: number;
    readonly minPollGapMs: number;
    readonly backoffBaseMs: number;
    readonly backoffMaxMs: number;
  };
  readonly cache: { readonly negativeTtlMs: number; readonly maxEntries?: number };
  /** Append-only JSON lines: the one thing that must survive a restart. */
  readonly audit: { readonly file: string };
  readonly shutdownGraceMs: number;
  readonly hosts: readonly HostConfig[];
}

// None of these names a real file or host. Budgets are incidental: the
// supplier's response time has not been measured.
const DEFAULTS = {
  arachnidTimeoutMs: 5_000,
  pollTimeoutMs: 40_000,
  postTimeoutMs: 5_000,
  minPollGapMs: 250,
  backoffBaseMs: 1_000,
  backoffMaxMs: 30_000,
  shutdownGraceMs: 10_000,
} as const;

const HOST_ID = /^[A-Za-z0-9._-]{1,64}$/;

type Obj = Record<string, unknown>;

export async function loadConfig(path: string): Promise<ServiceConfig> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new ConfigError(`config: ${path} cannot be read`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ConfigError(`config: ${path} is not valid JSON`);
  }
  return parseConfig(parsed);
}

export function parseConfig(input: unknown): ServiceConfig {
  const root = object(input, 'config');
  noUnknownKeys(root, ['arachnid', 'channel', 'cache', 'audit', 'shutdownGraceMs', 'hosts'], 'config');

  const arachnid = object(root.arachnid, 'arachnid');
  noUnknownKeys(arachnid, ['baseUrl', 'credentialFile', 'timeoutMs', 'maxBatchSize'], 'arachnid');
  const channel = object(root.channel, 'channel');
  noUnknownKeys(
    channel,
    ['signingKeyFile', 'pollTimeoutMs', 'postTimeoutMs', 'minPollGapMs', 'backoffBaseMs', 'backoffMaxMs'],
    'channel'
  );
  const cache = object(root.cache, 'cache');
  noUnknownKeys(cache, ['negativeTtlMs', 'maxEntries'], 'cache');
  const audit = object(root.audit, 'audit');
  noUnknownKeys(audit, ['file'], 'audit');

  const backoffBaseMs = positiveNumber(channel.backoffBaseMs ?? DEFAULTS.backoffBaseMs, 'channel.backoffBaseMs');
  const backoffMaxMs = positiveNumber(channel.backoffMaxMs ?? DEFAULTS.backoffMaxMs, 'channel.backoffMaxMs');
  if (backoffMaxMs < backoffBaseMs) {
    throw new ConfigError('config: channel.backoffMaxMs must be at least channel.backoffBaseMs');
  }
  const negativeTtlMs = positiveNumber(cache.negativeTtlMs, 'cache.negativeTtlMs');
  if (negativeTtlMs > MAX_NEGATIVE_TTL_MS) {
    throw new ConfigError(`config: cache.negativeTtlMs must be at most ${String(MAX_NEGATIVE_TTL_MS)}`);
  }

  return {
    arachnid: {
      baseUrl: transportUrl(arachnid.baseUrl, 'arachnid.baseUrl'),
      credentialFile: filePath(arachnid.credentialFile, 'arachnid.credentialFile'),
      timeoutMs: positiveNumber(arachnid.timeoutMs ?? DEFAULTS.arachnidTimeoutMs, 'arachnid.timeoutMs'),
      ...(arachnid.maxBatchSize === undefined
        ? {}
        : { maxBatchSize: positiveInteger(arachnid.maxBatchSize, 'arachnid.maxBatchSize') }),
    },
    channel: {
      signingKeyFile: filePath(channel.signingKeyFile, 'channel.signingKeyFile'),
      pollTimeoutMs: positiveNumber(channel.pollTimeoutMs ?? DEFAULTS.pollTimeoutMs, 'channel.pollTimeoutMs'),
      postTimeoutMs: positiveNumber(channel.postTimeoutMs ?? DEFAULTS.postTimeoutMs, 'channel.postTimeoutMs'),
      minPollGapMs: nonNegativeNumber(channel.minPollGapMs ?? DEFAULTS.minPollGapMs, 'channel.minPollGapMs'),
      backoffBaseMs,
      backoffMaxMs,
    },
    cache: {
      negativeTtlMs,
      ...(cache.maxEntries === undefined ? {} : { maxEntries: positiveInteger(cache.maxEntries, 'cache.maxEntries') }),
    },
    audit: { file: filePath(audit.file, 'audit.file') },
    shutdownGraceMs: nonNegativeNumber(root.shutdownGraceMs ?? DEFAULTS.shutdownGraceMs, 'shutdownGraceMs'),
    hosts: hosts(root.hosts),
  };
}

function hosts(value: unknown): readonly HostConfig[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ConfigError('config: hosts must be a non-empty array');
  }
  const seen = new Set<string>();
  return (value as readonly unknown[]).map((entry, index): HostConfig => {
    const where = `hosts[${String(index)}]`;
    const host = object(entry, where);
    noUnknownKeys(host, ['id', 'kind', 'safety', 'endpoint'], where);
    const id = host.id;
    if (typeof id !== 'string' || !HOST_ID.test(id)) {
      throw new ConfigError(`config: ${where}.id must match ${String(HOST_ID)}`);
    }
    if (seen.has(id)) throw new ConfigError(`config: ${where}.id repeats an earlier host`);
    seen.add(id);
    if (host.kind !== 'demo' && host.kind !== 'tenant') {
      throw new ConfigError(`config: ${where}.kind must be "demo" or "tenant"`);
    }
    const safety = object(host.safety, `${where}.safety`);
    noUnknownKeys(safety, ['near', 'exact'], `${where}.safety`);
    if (typeof safety.near !== 'boolean' || typeof safety.exact !== 'boolean') {
      throw new ConfigError(`config: ${where}.safety.near and .exact must be booleans`);
    }
    return {
      id,
      kind: host.kind,
      safety: { near: safety.near, exact: safety.exact },
      endpoint: transportUrl(host.endpoint, `${where}.endpoint`),
    };
  });
}

/**
 * Plain http only for loopback; anything else must be https, because an
 * unauthenticated peer would be an oracle for which hashes are listed.
 */
function transportUrl(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new ConfigError(`config: ${name} must be a URL string`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`config: ${name} is not a URL`);
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(\.\d{1,3}){3}$/.test(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new ConfigError(`config: ${name} must be https (http is accepted for loopback only)`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new ConfigError(`config: ${name} must not carry credentials`);
  }
  if (url.search !== '' || url.hash !== '') {
    throw new ConfigError(`config: ${name} must not carry a query or fragment`);
  }
  if (url.pathname !== '/') {
    throw new ConfigError(`config: ${name} must be an origin with no path`);
  }
  return url.origin;
}

function filePath(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConfigError(`config: ${name} is required and names a file on this host`);
  }
  return value;
}

function object(value: unknown, name: string): Obj {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(`config: ${name} must be an object`);
  }
  return value as Obj;
}

function noUnknownKeys(value: Obj, allowed: readonly string[], name: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new ConfigError(`config: ${name} has an unknown key`);
  }
}

function positiveNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`config: ${name} must be a positive number`);
  }
  return value;
}

function nonNegativeNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ConfigError(`config: ${name} must be zero or a positive number`);
  }
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new ConfigError(`config: ${name} must be a positive integer`);
  }
  return value;
}
