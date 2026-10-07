import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArachnidPdqClient } from '../src/arachnid-client.js';
import type { LookupResult, PdqHash, PdqLookup, Verdict, VerdictCache } from '../src/contract.js';
import { PDQ_CHECK_SOURCE, PdqKnownMaterialCheck } from '../src/pdq-known-material-check.js';
import { InMemoryVerdictCache } from '../src/verdict-cache.js';
import { hashOf } from './helpers/fixtures.js';
import { startStubArachnid, type StubArachnid } from './helpers/stub-arachnid.js';

const DAY = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 200;

describe('PdqKnownMaterialCheck against the local stub', () => {
  let stub: StubArachnid;
  let check: PdqKnownMaterialCheck;

  beforeEach(async () => {
    stub = await startStubArachnid(
      new Map([
        [hashOf(1), { classification: 'csam', match_type: 'exact' }],
        [hashOf(2), { classification: 'csam', match_type: 'near' }],
        [hashOf(3), { classification: 'test', match_type: 'exact' }],
      ])
    );
    check = new PdqKnownMaterialCheck({
      lookup: new ArachnidPdqClient({ baseUrl: stub.baseUrl, authorization: () => 'PLACEHOLDER_NOT_A_CREDENTIAL' }),
      cache: new InMemoryVerdictCache({ negativeTtlMs: DAY }),
      timeoutMs: TIMEOUT_MS,
    });
  });

  afterEach(async () => {
    await stub.close();
  });

  it('declares itself a blocking media check', () => {
    expect(check.kind).toBe('media');
    expect(check.blocking).toBe(true);
  });

  it('answers a batch with one verdict per hash, in order', async () => {
    const asked = [hashOf(4), hashOf(1), hashOf(2), hashOf(3)];
    const verdicts = await check.runBatch(asked);
    expect(verdicts).toEqual([
      { classification: 'no-known-match', source: PDQ_CHECK_SOURCE, evidence: hashOf(4) },
      { classification: 'csam', matchType: 'exact', source: PDQ_CHECK_SOURCE, evidence: hashOf(1) },
      { classification: 'csam', matchType: 'near', source: PDQ_CHECK_SOURCE, evidence: hashOf(2) },
      { classification: 'test', matchType: 'exact', source: PDQ_CHECK_SOURCE, evidence: hashOf(3) },
    ]);
    expect(stub.requests).toHaveLength(1);
  });

  it('asks about a repeated hash once and answers every occurrence', async () => {
    const verdicts = await check.runBatch([hashOf(1), hashOf(1)]);
    expect(verdicts).toHaveLength(2);
    expect(JSON.parse(stub.requests[0]?.body ?? '{}')).toEqual({ hashes: [hashOf(1)] });
  });

  it('answers a hash seen once from the cache without a second call', async () => {
    await check.runBatch([hashOf(1), hashOf(4)]);
    const again = await check.runBatch([hashOf(1), hashOf(4)]);
    expect(again.map((v) => v.classification)).toEqual(['csam', 'no-known-match']);
    expect(stub.requests).toHaveLength(1);
  });

  it('asks only about the hashes the cache cannot answer', async () => {
    await check.runBatch([hashOf(1)]);
    await check.runBatch([hashOf(1), hashOf(5)]);
    expect(stub.requests).toHaveLength(2);
    expect(JSON.parse(stub.requests[1]?.body ?? '{}')).toEqual({ hashes: [hashOf(5)] });
  });

  it('yields unavailable within the timeout when the stub never answers, not a hang', async () => {
    stub.mode = 'never-answer';
    const started = performance.now();
    const verdicts = await check.runBatch([hashOf(1), hashOf(4)]);
    const elapsed = performance.now() - started;
    expect(verdicts.map((v) => v.classification)).toEqual(['unavailable', 'unavailable']);
    expect(elapsed).toBeLessThan(TIMEOUT_MS + 500);
  });

  it('does not cache unavailable, so the next call asks again', async () => {
    stub.mode = 'never-answer';
    await check.runBatch([hashOf(1)]);
    stub.mode = 'answer';
    const [verdict] = await check.runBatch([hashOf(1)]);
    expect(verdict?.classification).toBe('csam');
  });

  it('yields unavailable on a server error', async () => {
    stub.mode = 'server-error';
    expect((await check.run(hashOf(1))).classification).toBe('unavailable');
  });

  it('answers a single subject through run()', async () => {
    expect(await check.run(hashOf(2))).toEqual({
      classification: 'csam',
      matchType: 'near',
      source: PDQ_CHECK_SOURCE,
      evidence: hashOf(2),
    });
  });
});

function lookupOf(fn: (hashes: readonly PdqHash[], signal: AbortSignal) => Promise<ReadonlyMap<PdqHash, LookupResult>>): PdqLookup & { calls: (readonly PdqHash[])[] } {
  const calls: (readonly PdqHash[])[] = [];
  return {
    calls,
    lookup: (hashes, signal) => {
      calls.push(hashes);
      return fn(hashes, signal);
    },
  };
}

describe('PdqKnownMaterialCheck with an injected lookup', () => {
  const cache = (): InMemoryVerdictCache => new InMemoryVerdictCache({ negativeTtlMs: DAY });

  it('bounds a lookup that ignores its abort signal', async () => {
    const lookup = lookupOf(() => new Promise(() => undefined));
    const check = new PdqKnownMaterialCheck({ lookup, cache: cache(), timeoutMs: 50 });
    const started = performance.now();
    expect((await check.run(hashOf(1))).classification).toBe('unavailable');
    expect(performance.now() - started).toBeLessThan(550);
  });

  it('aborts the signal it handed the lookup when the budget runs out', async () => {
    let seen: AbortSignal | undefined;
    const lookup = lookupOf((_h, signal) => {
      seen = signal;
      return new Promise(() => undefined);
    });
    const check = new PdqKnownMaterialCheck({ lookup, cache: cache(), timeoutMs: 20 });
    await check.run(hashOf(1));
    expect(seen?.aborted).toBe(true);
  });

  it('yields unavailable for a hash the answer leaves out', async () => {
    const lookup = lookupOf(() => Promise.resolve(new Map([[hashOf(1), { classification: 'no-known-match' as const }]])));
    const check = new PdqKnownMaterialCheck({ lookup, cache: cache(), timeoutMs: 100 });
    const verdicts = await check.runBatch([hashOf(1), hashOf(2)]);
    expect(verdicts.map((v) => v.classification)).toEqual(['no-known-match', 'unavailable']);
  });

  it('yields unavailable when the lookup rejects', async () => {
    const lookup = lookupOf(() => Promise.reject(new Error('down')));
    const check = new PdqKnownMaterialCheck({ lookup, cache: cache(), timeoutMs: 100 });
    expect((await check.run(hashOf(1))).classification).toBe('unavailable');
  });

  it('splits a large batch into chunks and asks them concurrently, under one timeout', async () => {
    const lookup = lookupOf((hashes) =>
      new Promise((resolve) =>
        setTimeout(() => resolve(new Map(hashes.map((h) => [h, { classification: 'no-known-match' as const }]))), 60)
      )
    );
    const check = new PdqKnownMaterialCheck({ lookup, cache: cache(), timeoutMs: 100, maxBatchSize: 2 });
    const asked = [1, 2, 3, 4, 5].map(hashOf);
    const verdicts = await check.runBatch(asked);
    expect(lookup.calls.map((c) => c.length)).toEqual([2, 2, 1]);
    expect(verdicts.every((v) => v.classification === 'no-known-match')).toBe(true);
  });

  it('still answers when the cache cannot be read or written', async () => {
    const broken: VerdictCache = {
      get: () => Promise.reject(new Error('cache down')),
      put: () => Promise.reject(new Error('cache down')),
    };
    const lookup = lookupOf(() => Promise.resolve(new Map([[hashOf(1), { classification: 'csam' as const, matchType: 'exact' as const }]])));
    const check = new PdqKnownMaterialCheck({ lookup, cache: broken, timeoutMs: 100 });
    const verdict: Verdict = await check.run(hashOf(1));
    expect(verdict.classification).toBe('csam');
  });

  it('refuses a timeout or batch size that does not bound anything', () => {
    const lookup = lookupOf(() => Promise.resolve(new Map()));
    for (const timeoutMs of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(() => new PdqKnownMaterialCheck({ lookup, cache: cache(), timeoutMs })).toThrow(RangeError);
    }
    for (const maxBatchSize of [0, 1.5, -2]) {
      expect(() => new PdqKnownMaterialCheck({ lookup, cache: cache(), timeoutMs: 10, maxBatchSize })).toThrow(RangeError);
    }
  });

  it('answers an empty batch without asking anything', async () => {
    const lookup = lookupOf(() => Promise.resolve(new Map()));
    const check = new PdqKnownMaterialCheck({ lookup, cache: cache(), timeoutMs: 10 });
    expect(await check.runBatch([])).toEqual([]);
    expect(lookup.calls).toHaveLength(0);
  });
});
