import { describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../src/arachnid-client.js';
import { MAX_BODY_BYTES } from '../src/channel-contract.js';
import type { Assessment, PdqHash } from '../src/contract.js';
import { HostChannel, type HostChannelOptions } from '../src/host-channel.js';
import { Secret } from '../src/credential.js';
import { RequestSigner } from '../src/request-signer.js';
import { DEMO, hashOf } from './helpers/fixtures.js';
import { makeSigningKey } from './helpers/keys.js';
import { endlessBody, type StreamStats } from './helpers/streams.js';

const BATCH = 'batch-0123456789abcdef';

interface Sent {
  readonly url: string;
  readonly init: RequestInit;
}

function json(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
}

function allow(hash: PdqHash): Assessment {
  return {
    hash,
    verdict: { classification: 'no-known-match', source: 'test', evidence: hash },
    decision: { action: 'allow' },
    audited: true,
  };
}

function build(
  answers: (sent: Sent, count: number) => Response | Promise<Response>,
  overrides: Partial<HostChannelOptions> = {}
): { channel: HostChannel; sent: Sent[]; logs: [string, Record<string, unknown>][]; sleeps: number[] } {
  const sent: Sent[] = [];
  const logs: [string, Record<string, unknown>][] = [];
  const sleeps: number[] = [];
  const fetch: FetchLike = async (url, init) => {
    const entry = { url, init };
    sent.push(entry);
    return answers(entry, sent.length);
  };
  const channel = new HostChannel({
    host: { id: 'HOST_A', kind: 'demo', safety: DEMO.safety, endpoint: 'http://127.0.0.1:1' },
    assess: async (hashes) => hashes.map(allow),
    signer: new RequestSigner(new Secret(makeSigningKey().seedBase64)),
    log: (event, fields) => logs.push([event, { ...fields }]),
    fetch,
    pollTimeoutMs: 1000,
    postTimeoutMs: 1000,
    minPollGapMs: 100,
    backoffBaseMs: 10,
    backoffMaxMs: 50,
    sleep: (ms) => {
      sleeps.push(ms);
      return new Promise<void>((resolve) => setTimeout(resolve, 0));
    },
    ...overrides,
  });
  return { channel, sent, logs, sleeps };
}

const batchOf = (...hashes: unknown[]): Response => json(200, { v: 1, batch: BATCH, hashes });

describe('HostChannel.runOnce', () => {
  it('polls with a signed GET, assesses in the host kind context, and posts the verdicts', async () => {
    const assessed: unknown[] = [];
    const { channel, sent } = build((_, n) => (n === 1 ? batchOf(hashOf(1)) : json(204, undefined)), {
      assess: async (hashes, context) => {
        assessed.push(context);
        return hashes.map(allow);
      },
    });

    expect(await channel.runOnce()).toBe('answered');

    expect(sent.map((s) => s.init.method)).toEqual(['GET', 'POST']);
    expect(sent[0]?.url).toBe('http://127.0.0.1:1/safety/v1/pending');
    expect(sent[1]?.url).toBe('http://127.0.0.1:1/safety/v1/verdicts');
    expect(Object.keys(sent[0]?.init.headers as object)).toContain('x-broker-signature');
    expect(Object.keys(sent[1]?.init.headers as object)).toContain('x-broker-signature');
    expect(sent[0]?.init.redirect).toBe('error');
    expect(assessed).toEqual([{ kind: 'demo', safety: { near: true, exact: true } }]);
    expect(JSON.parse(sent[1]?.init.body as string)).toMatchObject({ v: 1, batch: BATCH });
  });

  it('answers every hash `unavailable` when the assessment itself throws, rather than dropping them', async () => {
    const { channel, sent, logs } = build((_, n) => (n === 1 ? batchOf(hashOf(1), hashOf(2)) : json(204, undefined)), {
      assess: () => Promise.reject(new Error('boom TEST_SENTINEL')),
    });

    expect(await channel.runOnce()).toBe('degraded');

    const posted = JSON.parse(sent[1]?.init.body as string) as { verdicts: { hash: string; classification: string; decision: unknown }[] };
    expect(posted.verdicts.map((v) => v.classification)).toEqual(['unavailable', 'unavailable']);
    expect(posted.verdicts[0]?.decision).toEqual({ action: 'hold', reason: 'unavailable' });
    expect(logs.map(([event]) => event)).toContain('assess-failed');
    expect(JSON.stringify(logs)).not.toContain('TEST_SENTINEL');
  });

  it('reports an empty poll without posting', async () => {
    const { channel, sent } = build(() => json(200, { v: 1, hashes: [] }));

    expect(await channel.runOnce()).toBe('empty');
    expect(sent).toHaveLength(1);
  });

  it('says when a batch held only entries it cannot answer, and posts nothing', async () => {
    const { channel, sent, logs } = build(() => batchOf('not-a-hash', 7));

    expect(await channel.runOnce()).toBe('empty');
    expect(sent).toHaveLength(1);
    expect(logs).toEqual([['batch-unanswerable', { host: 'HOST_A', skipped: 2 }]]);
  });

  it('fails a poll the host refuses, that is not JSON, that breaks the contract, or is too large', async () => {
    const cases: [() => Response, string][] = [
      [() => json(401, undefined), 'host-answered-401'],
      [() => new Response('<html>', { status: 200 }), 'response-not-json'],
      [() => json(200, { v: 9, hashes: [] }), 'response-breaks-contract'],
      [() => new Response('x'.repeat(300 * 1024), { status: 200 }), 'response-too-large'],
    ];
    for (const [response, reason] of cases) {
      const { channel, logs } = build(response);

      expect(await channel.runOnce()).toBe('failed');
      expect(logs).toEqual([['poll-failed', { host: 'HOST_A', reason }]]);
    }
  });

  it('counts bytes: a poll answer over the bound in bytes but under it in characters is refused', async () => {
    const padding = '€'.repeat(100_000);
    expect(padding.length).toBeLessThan(MAX_BODY_BYTES);
    expect(Buffer.byteLength(padding)).toBeGreaterThan(MAX_BODY_BYTES);
    const { channel, logs } = build(() => json(200, { v: 1, hashes: [], padding }));

    expect(await channel.runOnce()).toBe('failed');
    expect(logs).toEqual([['poll-failed', { host: 'HOST_A', reason: 'response-too-large' }]]);
  });

  it('stops reading a poll answer that never ends, soon after the bound, and cancels it', async () => {
    const streams: StreamStats[] = [];
    const { channel, logs } = build(() => {
      const { response, stats } = endlessBody(16 * 1024);
      streams.push(stats);
      return response;
    });

    expect(await channel.runOnce()).toBe('failed');

    expect(logs).toEqual([['poll-failed', { host: 'HOST_A', reason: 'response-too-large' }]]);
    expect(streams[0]?.pulled).toBeGreaterThan(MAX_BODY_BYTES);
    expect(streams[0]?.pulled).toBeLessThanOrEqual(MAX_BODY_BYTES + 64 * 1024);
    await vi.waitFor(() => expect(streams[0]?.cancelled).toBe(true));
  });

  it('bounds the answer to a verdict post the same way, and fails the round', async () => {
    const streams: StreamStats[] = [];
    const { channel, logs } = build((_, n) => {
      if (n === 1) return batchOf(hashOf(1));
      const { response, stats } = endlessBody(16 * 1024);
      streams.push(stats);
      return response;
    });

    expect(await channel.runOnce()).toBe('failed');

    expect(logs.at(-1)).toEqual(['verdicts-failed', { host: 'HOST_A', reason: 'response-too-large' }]);
    expect(streams[0]?.pulled).toBeLessThanOrEqual(MAX_BODY_BYTES + 64 * 1024);
    await vi.waitFor(() => expect(streams[0]?.cancelled).toBe(true));
  });

  it('counts only a 204 as the verdicts taken: a 200, 201 or 202 is a failure', async () => {
    for (const status of [200, 201, 202]) {
      const { channel, logs } = build((_, n) => (n === 1 ? batchOf(hashOf(1)) : new Response('', { status })));

      expect(await channel.runOnce()).toBe('failed');
      expect(logs.at(-1)).toEqual(['verdicts-failed', { host: 'HOST_A', reason: `host-answered-${String(status)}` }]);
    }
  });

  it('names an unreachable host and a timed-out poll by fixed reasons only', async () => {
    const unreachable = build(() => {
      throw new TypeError('fetch failed: connect ECONNREFUSED 10.0.0.1:443');
    });
    const timedOut = build(() => {
      throw new DOMException('The operation timed out', 'TimeoutError');
    });

    expect(await unreachable.channel.runOnce()).toBe('failed');
    expect(await timedOut.channel.runOnce()).toBe('failed');
    expect(unreachable.logs).toEqual([['poll-failed', { host: 'HOST_A', reason: 'unreachable' }]]);
    expect(timedOut.logs).toEqual([['poll-failed', { host: 'HOST_A', reason: 'timeout' }]]);
  });

  it('fails when the verdicts cannot be delivered, so the loop backs off and the host re-offers the batch', async () => {
    const refused = build((_, n) => (n === 1 ? batchOf(hashOf(1)) : json(503, undefined)));
    const down = build((_, n) => {
      if (n === 1) return batchOf(hashOf(1));
      throw new TypeError('fetch failed');
    });

    expect(await refused.channel.runOnce()).toBe('failed');
    expect(refused.logs.at(-1)).toEqual(['verdicts-failed', { host: 'HOST_A', reason: 'host-answered-503' }]);
    expect(await down.channel.runOnce()).toBe('failed');
  });

  it('treats a batch the host no longer holds as answered, not as a failure to retry', async () => {
    const { channel, logs } = build((_, n) => (n === 1 ? batchOf(hashOf(1)) : json(409, undefined)));

    expect(await channel.runOnce()).toBe('answered');
    expect(logs.at(-1)?.[0]).toBe('batch-expired');
  });
});

describe('HostChannel when the hash source is down', () => {
  const unavailableFor = async (hashes: readonly PdqHash[]): Promise<Assessment[]> =>
    hashes.map((hash) => ({
      hash,
      verdict: { classification: 'unavailable', source: 'test', evidence: hash },
      decision: { action: 'hold', reason: 'unavailable' },
      audited: true,
    }));

  it('reports a batch that came back wholly unavailable as degraded, with the count', async () => {
    const { channel, logs } = build((_, n) => (n === 1 ? batchOf(hashOf(1), hashOf(2)) : json(204, undefined)), {
      assess: unavailableFor,
    });

    expect(await channel.runOnce()).toBe('degraded');
    expect(logs.at(-1)).toEqual(['batch-answered', { host: 'HOST_A', answered: 2, unavailable: 2, skipped: 0 }]);
  });

  it('reports a batch with any real verdict as answered', async () => {
    const { channel } = build((_, n) => (n === 1 ? batchOf(hashOf(1), hashOf(2)) : json(204, undefined)), {
      assess: async (hashes) => [...(await unavailableFor(hashes.slice(0, 1))), allow(hashes[1] as PdqHash)],
    });

    expect(await channel.runOnce()).toBe('answered');
  });

  it('does not reset its backoff on an unavailable batch, so a host that re-offers at once cannot storm the source', async () => {
    const { channel, sleeps } = build(
      async (_, n) => {
        // Yields to timers, so a loop that stopped backing off fails the
        // assertion below instead of starving the test of its own clock.
        await new Promise((resolve) => setTimeout(resolve, 1));
        return n % 2 === 1 ? batchOf(hashOf(1)) : json(204, undefined);
      },
      { assess: unavailableFor, now: () => 0 }
    );
    channel.start();
    try {
      await vi.waitFor(() => expect(sleeps.length).toBeGreaterThanOrEqual(5), { timeout: 2000 });
      expect(sleeps.slice(0, 5)).toEqual([10, 20, 40, 50, 50]);
    } finally {
      await channel.stop();
    }
  });
});

describe('HostChannel loop', () => {
  it('backs off exponentially up to a ceiling, resets on success, and spaces empty polls', async () => {
    let calls = 0;
    const { channel, sleeps } = build(
      (_, n) => {
        calls = n;
        if (n <= 6) return json(503, undefined);
        return json(200, { v: 1, hashes: [] });
      },
      { minPollGapMs: 100, now: () => 0 }
    );
    channel.start();
    channel.start();
    await vi.waitFor(() => expect(sleeps.length).toBeGreaterThanOrEqual(8));
    await channel.stop();

    expect(calls).toBeGreaterThan(7);
    expect(sleeps.slice(0, 6)).toEqual([10, 20, 40, 50, 50, 50]);
    expect(sleeps.slice(6, 8)).toEqual([100, 100]);
  });

  it('polls again at once after an answered batch, with no sleep', async () => {
    const { channel, sleeps, sent } = build(
      (_, n) => {
        if (n === 1) return batchOf(hashOf(1));
        if (n === 2) return json(204, undefined);
        return json(200, { v: 1, hashes: [] });
      },
      { now: () => 0 }
    );
    channel.start();
    await vi.waitFor(() => expect(sleeps.length).toBeGreaterThanOrEqual(1));
    await channel.stop();

    expect(sent.length).toBeGreaterThanOrEqual(3);
    expect(sleeps[0]).toBe(100);
  });

  it('stop resolves even when it was never started, and ends a poll that is being held', async () => {
    const idle = build(() => json(200, { v: 1, hashes: [] }));
    await idle.channel.stop();

    const held = build(
      (sent) =>
        new Promise<Response>((_, reject) => {
          (sent.init.signal as AbortSignal).addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
      { sleep: undefined as never }
    );
    held.channel.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const started = Date.now();
    await held.channel.stop();

    expect(Date.now() - started).toBeLessThan(500);
    expect(held.logs).toEqual([]);
  });
});
