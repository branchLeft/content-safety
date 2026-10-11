import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseConfig } from '../src/config.js';
import { MAX_NEGATIVE_TTL_MS } from '../src/verdict-cache.js';

function valid(): Record<string, unknown> {
  return {
    arachnid: { baseUrl: 'https://hash-source.example.invalid', credentialFile: 'CREDENTIAL_FILE_PATH' },
    channel: { signingKeyFile: 'SIGNING_KEY_FILE_PATH' },
    cache: { negativeTtlMs: 3_600_000 },
    audit: { file: 'AUDIT_FILE_PATH' },
    hosts: [
      {
        id: 'HOST_ONE',
        kind: 'demo',
        safety: { near: true, exact: true },
        endpoint: 'https://host-one.example.invalid',
      },
    ],
  };
}

function withChange(change: (config: Record<string, any>) => void): Record<string, unknown> {
  const config = valid();
  change(config);
  return config;
}

function refusal(config: unknown): string {
  try {
    parseConfig(config);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }
  throw new Error('expected a refusal');
}

describe('parseConfig', () => {
  it('reads a complete configuration and fills only budgets', () => {
    const config = parseConfig(valid());

    expect(config.arachnid.credentialFile).toBe('CREDENTIAL_FILE_PATH');
    expect(config.channel.signingKeyFile).toBe('SIGNING_KEY_FILE_PATH');
    expect(config.arachnid.timeoutMs).toBe(5000);
    expect(config.channel.pollTimeoutMs).toBeGreaterThan(30_000);
    expect(config.hosts).toEqual([
      {
        id: 'HOST_ONE',
        kind: 'demo',
        safety: { near: true, exact: true },
        endpoint: 'https://host-one.example.invalid',
      },
    ]);
  });

  it('keeps the optional bounds it is given', () => {
    const config = parseConfig(
      withChange((c) => {
        c.arachnid.maxBatchSize = 10;
        c.cache.maxEntries = 5;
        c.channel.minPollGapMs = 0;
      })
    );

    expect(config.arachnid.maxBatchSize).toBe(10);
    expect(config.cache.maxEntries).toBe(5);
    expect(config.channel.minPollGapMs).toBe(0);
  });

  it('names no default for a file, a host or an address', () => {
    for (const missing of [
      (c: Record<string, any>) => delete c.arachnid.credentialFile,
      (c: Record<string, any>) => delete c.arachnid.baseUrl,
      (c: Record<string, any>) => delete c.channel.signingKeyFile,
      (c: Record<string, any>) => delete c.audit.file,
      (c: Record<string, any>) => delete c.cache.negativeTtlMs,
      (c: Record<string, any>) => delete c.hosts,
    ]) {
      expect(() => parseConfig(withChange(missing))).toThrow(ConfigError);
    }
    expect(refusal(withChange((c) => delete c.arachnid.credentialFile))).toContain('arachnid.credentialFile');
  });

  it('refuses an unknown key anywhere, so a misspelt safety setting is not ignored', () => {
    expect(refusal(withChange((c) => (c.extra = 1)))).toContain('unknown key "extra"');
    expect(refusal(withChange((c) => (c.hosts[0].extra = 1)))).toContain('hosts[0]');
    expect(refusal(withChange((c) => (c.arachnid.credential = 'x')))).toContain('arachnid');
  });

  it('accepts plain http for loopback only, and https elsewhere', () => {
    const loopback = parseConfig(
      withChange((c) => {
        c.hosts[0].endpoint = 'http://127.0.0.1:8080';
        c.arachnid.baseUrl = 'http://localhost:9000';
      })
    );
    expect(loopback.hosts[0]?.endpoint).toBe('http://127.0.0.1:8080');

    expect(refusal(withChange((c) => (c.hosts[0].endpoint = 'http://10.0.0.5:8080')))).toContain('https');
    expect(refusal(withChange((c) => (c.arachnid.baseUrl = 'http://hash-source.example.invalid')))).toContain('https');
    expect(refusal(withChange((c) => (c.hosts[0].endpoint = 'ftp://host.example.invalid')))).toContain('https');
  });

  it('refuses a URL with credentials, a query, a fragment or a path', () => {
    for (const endpoint of [
      'https://user:pass@host.example.invalid',
      'https://host.example.invalid/?a=1',
      'https://host.example.invalid/#x',
      'https://host.example.invalid/some/path',
      'not a url',
      42,
    ]) {
      expect(() => parseConfig(withChange((c) => (c.hosts[0].endpoint = endpoint)))).toThrow(ConfigError);
    }
  });

  it('refuses a negative lifetime past the cache ceiling and budgets that make no sense', () => {
    expect(() => parseConfig(withChange((c) => (c.cache.negativeTtlMs = MAX_NEGATIVE_TTL_MS + 1)))).toThrow(
      ConfigError
    );
    expect(() => parseConfig(withChange((c) => (c.arachnid.timeoutMs = 0)))).toThrow(ConfigError);
    expect(() => parseConfig(withChange((c) => (c.channel.minPollGapMs = -1)))).toThrow(ConfigError);
    expect(() => parseConfig(withChange((c) => (c.arachnid.maxBatchSize = 1.5)))).toThrow(ConfigError);
    expect(() =>
      parseConfig(
        withChange((c) => {
          c.channel.backoffBaseMs = 100;
          c.channel.backoffMaxMs = 10;
        })
      )
    ).toThrow(ConfigError);
  });

  it('refuses malformed hosts: none, repeated ids, a bad id or kind, or a safety axis that is not boolean', () => {
    expect(() => parseConfig(withChange((c) => (c.hosts = [])))).toThrow(ConfigError);
    expect(() => parseConfig(withChange((c) => c.hosts.push({ ...c.hosts[0] })))).toThrow(/repeats/);
    expect(() => parseConfig(withChange((c) => (c.hosts[0].id = 'has space')))).toThrow(ConfigError);
    expect(() => parseConfig(withChange((c) => (c.hosts[0].kind = 'staging')))).toThrow(ConfigError);
    expect(() => parseConfig(withChange((c) => (c.hosts[0].safety = { near: 'yes', exact: true })))).toThrow(
      ConfigError
    );
    expect(() => parseConfig(withChange((c) => (c.hosts[0] = 'HOST_ONE')))).toThrow(ConfigError);
    expect(() => parseConfig('config')).toThrow(ConfigError);
  });
});

describe('loadConfig', () => {
  it('reads a file, and refuses one that is missing or not JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'content-safety-config-'));
    try {
      const good = join(dir, 'good.json');
      const bad = join(dir, 'bad.json');
      await writeFile(good, JSON.stringify(valid()));
      await writeFile(bad, '{ not json');

      expect((await loadConfig(good)).hosts).toHaveLength(1);
      await expect(loadConfig(bad)).rejects.toThrow('not valid JSON');
      await expect(loadConfig(join(dir, 'absent.json'))).rejects.toThrow('cannot be read');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
