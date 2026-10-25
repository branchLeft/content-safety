import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArachnidPdqClient } from '../src/arachnid-client.js';
import type { Assessment, AuditRecord, AuditSink, PdqHash, RescannableVerdictCache } from '../src/contract.js';
import { DeadlineExceeded } from '../src/deadline.js';
import { PdqKnownMaterialCheck } from '../src/pdq-known-material-check.js';
import { EstatePolicy } from '../src/policy.js';
import {
  MAX_RESCAN_INTERVAL_MS,
  RescanSweep,
  type StoredHashPage,
  type StoredHashSource,
  type StoredObject,
} from '../src/rescan-sweep.js';
import { SafetyService } from '../src/safety-service.js';
import { InMemoryVerdictCache } from '../src/verdict-cache.js';
import { DEMO, hashOf, TENANT } from './helpers/fixtures.js';
import { startStubArachnid, type StubArachnid } from './helpers/stub-arachnid.js';

const DAY = 24 * 60 * 60 * 1000;
const LISTED = { classification: 'csam', match_type: 'exact' } as const;

class MemoryAudit implements AuditSink {
  readonly records: AuditRecord[] = [];
  record(entry: AuditRecord): Promise<void> {
    this.records.push(entry);
    return Promise.resolve();
  }
}

class MemoryStorage implements StoredHashSource {
  readonly served = new Map<string, StoredObject>();
  constructor(objects: readonly StoredObject[]) {
    for (const o of objects) this.served.set(o.ref, o);
  }
  page(cursor: string | undefined, limit: number): Promise<StoredHashPage> {
    const all = [...this.served.values()];
    const start = cursor === undefined ? 0 : Number(cursor);
    const objects = all.slice(start, start + limit);
    const end = start + limit;
    return Promise.resolve(end < all.length ? { objects, next: String(end) } : { objects });
  }
}

function object(ref: string, n: number, context = TENANT): StoredObject {
  return { ref, hash: hashOf(n), context };
}

describe('negative verdicts expire and stored hashes are re-submitted', () => {
  let stub: StubArachnid;
  let now: number;
  let cache: InMemoryVerdictCache;
  let service: SafetyService;

  beforeEach(async () => {
    stub = await startStubArachnid();
    now = 0;
    cache = new InMemoryVerdictCache({ negativeTtlMs: DAY, now: () => now });
    service = new SafetyService({
      check: new PdqKnownMaterialCheck({
        lookup: new ArachnidPdqClient({ baseUrl: stub.baseUrl, authorization: () => 'PLACEHOLDER_NOT_A_CREDENTIAL' }),
        cache,
        timeoutMs: 1000,
        maxBatchSize: 100,
      }),
      policy: new EstatePolicy(),
      audit: new MemoryAudit(),
    });
  });

  afterEach(async () => {
    await stub.close();
  });

  function sweepOver(storage: MemoryStorage, withdrawn: string[] = [], pageSize?: number): RescanSweep {
    return new RescanSweep({
      source: storage,
      cache,
      assess: (hashes: readonly PdqHash[], context) => service.assess(hashes, context),
      withdraw: (o: StoredObject, _a: Assessment) => {
        storage.served.delete(o.ref);
        withdrawn.push(o.ref);
        return Promise.resolve();
      },
      intervalMs: DAY,
      ...(pageSize === undefined ? {} : { pageSize }),
    });
  }

  it('control case: a hash that was clean, then listed, is caught once its negative expires', async () => {
    const hash = hashOf(1);
    expect((await service.assess([hash], TENANT))[0]?.decision.action).toBe('allow');
    stub.listed = new Map([[hash, LISTED]]);

    now = DAY - 1;
    expect((await service.assess([hash], TENANT))[0]?.decision.action).toBe('allow');

    now = DAY;
    const caught = (await service.assess([hash], TENANT))[0];
    expect(caught?.decision.action).toBe('refuse');
  });

  it('the sweep withdraws an object whose hash was listed after storing, and leaves a clean one served', async () => {
    const storage = new MemoryStorage([object('a', 1), object('b', 2)]);
    const withdrawn: string[] = [];
    const sweep = sweepOver(storage, withdrawn);

    expect(await sweep.sweep()).toMatchObject({ examined: 2, withdrawn: 0 });
    stub.listed = new Map([[hashOf(1), LISTED]]);

    // The negative from the first pass is still within its lifetime; the
    // sweep must ask regardless.
    const report = await sweep.sweep();
    expect(report).toEqual({ examined: 2, withdrawn: 1, withdrawFailed: 0, unanswered: 0 });
    expect(withdrawn).toEqual(['a']);
    expect([...storage.served.keys()]).toEqual(['b']);
  });

  it('keeps asking for a listed hash, so a failed withdrawal is retried next pass', async () => {
    stub.listed = new Map([[hashOf(1), LISTED]]);
    const storage = new MemoryStorage([object('a', 1)]);
    let fail = true;
    const sweep = new RescanSweep({
      source: storage,
      cache,
      assess: (h, c) => service.assess(h, c),
      withdraw: (o) => {
        if (fail) return Promise.reject(new Error('storage down'));
        storage.served.delete(o.ref);
        return Promise.resolve();
      },
      intervalMs: DAY,
      onError: () => undefined,
    });
    expect(await sweep.sweep()).toMatchObject({ withdrawn: 0, withdrawFailed: 1 });
    fail = false;
    expect(await sweep.sweep()).toMatchObject({ withdrawn: 1, withdrawFailed: 0 });
    expect(storage.served.size).toBe(0);
  });

  it('uses the batch endpoint: one request per page, not one per hash', async () => {
    const storage = new MemoryStorage([1, 2, 3, 4, 5, 6].map((n) => object(`o${String(n)}`, n)));
    await sweepOver(storage).sweep();
    expect(stub.requests).toHaveLength(1);
    expect((JSON.parse(stub.requests[0]?.body ?? '{}') as { hashes: string[] }).hashes).toHaveLength(6);

    stub.requests.length = 0;
    await sweepOver(storage, [], 2).sweep();
    expect(stub.requests).toHaveLength(3);
  });

  it('asks about a hash once per pass however many objects share it', async () => {
    const storage = new MemoryStorage([object('a', 1), object('b', 1), object('c', 1)]);
    stub.listed = new Map([[hashOf(1), LISTED]]);
    const withdrawn: string[] = [];
    await sweepOver(storage, withdrawn).sweep();
    expect(withdrawn).toEqual(['a', 'b', 'c']);
    expect((JSON.parse(stub.requests[0]?.body ?? '{}') as { hashes: string[] }).hashes).toHaveLength(1);
  });

  it('decides each object by its own estate', async () => {
    stub.listed = new Map([[hashOf(1), { classification: 'csam', match_type: 'near' }]]);
    const storage = new MemoryStorage([object('t', 1, TENANT), object('d', 1, DEMO)]);
    const seen: string[] = [];
    const sweep = new RescanSweep({
      source: storage,
      cache,
      assess: (h, c) => {
        seen.push(c.kind);
        return service.assess(h, c);
      },
      withdraw: () => Promise.resolve(),
      intervalMs: DAY,
    });
    expect(await sweep.sweep()).toMatchObject({ withdrawn: 2 });
    expect(seen.sort()).toEqual(['demo', 'tenant']);
  });

  it('withdraws nothing when the hash source cannot answer', async () => {
    stub.listed = new Map([[hashOf(1), LISTED]]);
    stub.mode = 'server-error';
    const storage = new MemoryStorage([object('a', 1)]);
    const withdrawn: string[] = [];
    const report = await sweepOver(storage, withdrawn).sweep();
    expect(report).toMatchObject({ withdrawn: 0, unanswered: 1 });
    expect(storage.served.size).toBe(1);
  });

  it('never drops a positive: a listing is not undone by a sweep', async () => {
    stub.listed = new Map([[hashOf(1), LISTED]]);
    await service.assess([hashOf(1)], TENANT);
    stub.listed = new Map();
    const storage = new MemoryStorage([object('a', 1)]);
    const withdrawn: string[] = [];
    await sweepOver(storage, withdrawn).sweep();
    expect(withdrawn).toEqual(['a']);
  });

  it('joins a pass already running instead of starting a second', async () => {
    const storage = new MemoryStorage([object('a', 1)]);
    const sweep = sweepOver(storage);
    const [first, second] = await Promise.all([sweep.sweep(), sweep.sweep()]);
    expect(first).toBe(second);
    expect(stub.requests).toHaveLength(1);
  });

  it('runs on its interval until stopped', async () => {
    const storage = new MemoryStorage([object('a', 1)]);
    const sweep = new RescanSweep({
      source: storage,
      cache,
      assess: (h, c) => service.assess(h, c),
      withdraw: () => Promise.resolve(),
      intervalMs: 20,
    });
    sweep.start();
    sweep.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    sweep.stop();
    sweep.stop();
    // A pass already in flight at stop() may still finish; none starts after.
    await new Promise((resolve) => setTimeout(resolve, 80));
    const after = stub.requests.length;
    expect(after).toBeGreaterThanOrEqual(2);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(stub.requests.length).toBe(after);
  });

  it('reports a failing pass through onError instead of an unhandled rejection', async () => {
    const errors: unknown[] = [];
    const sweep = new RescanSweep({
      source: { page: () => Promise.reject(new Error('listing failed')) },
      cache,
      assess: (h, c) => service.assess(h, c),
      withdraw: () => Promise.resolve(),
      intervalMs: 20,
      onError: (e) => errors.push(e),
    });
    sweep.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    sweep.stop();
    expect(errors.length).toBeGreaterThan(0);
  });

  it('refuses an interval longer than a negative may stand, or not positive', () => {
    const base = {
      source: new MemoryStorage([]),
      cache,
      assess: () => Promise.resolve([]),
      withdraw: () => Promise.resolve(),
    };
    expect(() => new RescanSweep({ ...base, intervalMs: MAX_RESCAN_INTERVAL_MS })).not.toThrow();
    expect(() => new RescanSweep({ ...base, intervalMs: MAX_RESCAN_INTERVAL_MS + 1 })).toThrow(RangeError);
    expect(() => new RescanSweep({ ...base, intervalMs: 0 })).toThrow(RangeError);
    expect(() => new RescanSweep({ ...base, intervalMs: DAY, pageSize: 0 })).toThrow(RangeError);
  });

  it('control case: a withdraw that never resolves does not stop later sweeps', async () => {
    stub.listed = new Map([[hashOf(1), LISTED]]);
    const storage = new MemoryStorage([object('a', 1)]);
    let withdrawCalls = 0;
    const errors: unknown[] = [];
    const sweep = new RescanSweep({
      source: storage,
      cache,
      assess: (h, c) => service.assess(h, c),
      withdraw: () => {
        withdrawCalls += 1;
        return new Promise<void>(() => {});
      },
      intervalMs: 20,
      callTimeoutMs: 10,
      onError: (e) => errors.push(e),
    });
    try {
      sweep.start();
      await new Promise((resolve) => setTimeout(resolve, 150));
    } finally {
      sweep.stop();
    }
    expect(errors).toContainEqual(expect.objectContaining({ name: 'DeadlineExceeded' }));
    expect(withdrawCalls).toBeGreaterThanOrEqual(2);
  });

  it('a withdraw that never resolves is counted as failed', async () => {
    stub.listed = new Map([[hashOf(1), LISTED]]);
    const storage = new MemoryStorage([object('a', 1)]);
    const sweep = new RescanSweep({
      source: storage,
      cache,
      assess: (h, c) => service.assess(h, c),
      withdraw: () => new Promise<void>(() => {}),
      intervalMs: DAY,
      callTimeoutMs: 10,
    });
    expect(await sweep.sweep()).toMatchObject({ withdrawn: 0, withdrawFailed: 1 });
  });

  it('a page that never resolves ends the pass and the next sweep runs', async () => {
    const storage = new MemoryStorage([object('a', 1)]);
    let pageCalls = 0;
    const sweep = new RescanSweep({
      source: {
        page: (cursor, limit) => {
          pageCalls += 1;
          return pageCalls === 1 ? new Promise<StoredHashPage>(() => {}) : storage.page(cursor, limit);
        },
      },
      cache,
      assess: (h, c) => service.assess(h, c),
      withdraw: () => Promise.resolve(),
      intervalMs: DAY,
      callTimeoutMs: 10,
    });
    await expect(sweep.sweep()).rejects.toBeInstanceOf(DeadlineExceeded);
    expect(await sweep.sweep()).toMatchObject({ examined: 1 });
    expect(pageCalls).toBeGreaterThanOrEqual(2);
  });

  it('a cache drop that never resolves ends the pass without assessing', async () => {
    const storage = new MemoryStorage([object('a', 1)]);
    let assessCalls = 0;
    const hangingCache: RescannableVerdictCache = {
      get: (h) => cache.get(h),
      put: (v) => cache.put(v),
      dropNegative: () => new Promise<void>(() => {}),
    };
    const sweep = new RescanSweep({
      source: storage,
      cache: hangingCache,
      assess: (h, c) => {
        assessCalls += 1;
        return service.assess(h, c);
      },
      withdraw: () => Promise.resolve(),
      intervalMs: DAY,
      callTimeoutMs: 10,
    });
    await expect(sweep.sweep()).rejects.toBeInstanceOf(DeadlineExceeded);
    expect(assessCalls).toBe(0);
  });

  it('refuses a call budget that is not a positive finite number', () => {
    const base = {
      source: new MemoryStorage([]),
      cache,
      assess: () => Promise.resolve([]),
      withdraw: () => Promise.resolve(),
      intervalMs: DAY,
    };
    for (const callTimeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new RescanSweep({ ...base, callTimeoutMs })).toThrow(RangeError);
    }
  });
});
