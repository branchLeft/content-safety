import { describe, expect, it } from 'vitest';
import type { Verdict } from '../src/contract.js';
import { InMemoryVerdictCache, isPositive, MAX_NEGATIVE_TTL_MS } from '../src/verdict-cache.js';
import { hashOf } from './helpers/fixtures.js';

const DAY = 24 * 60 * 60 * 1000;

function clock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

const negative: Verdict = { classification: 'no-known-match', source: 's', evidence: hashOf(1) };
const positive: Verdict = { classification: 'csam', matchType: 'exact', source: 's', evidence: hashOf(1) };

describe('InMemoryVerdictCache', () => {
  it('keeps a positive for ever', async () => {
    const c = clock();
    const cache = new InMemoryVerdictCache({ negativeTtlMs: DAY, now: c.now });
    await cache.put(positive);
    c.advance(10_000 * DAY);
    expect(await cache.get(hashOf(1))).toEqual(positive);
  });

  it('expires a negative after its bounded lifetime, and not before', async () => {
    const c = clock();
    const cache = new InMemoryVerdictCache({ negativeTtlMs: DAY, now: c.now });
    await cache.put(negative);
    c.advance(DAY - 1);
    expect(await cache.get(hashOf(1))).toEqual(negative);
    c.advance(1);
    expect(await cache.get(hashOf(1))).toBeUndefined();
  });

  it('never caches unavailable, because it is not an answer', async () => {
    const cache = new InMemoryVerdictCache({ negativeTtlMs: DAY });
    await cache.put({ classification: 'unavailable', source: 's', evidence: hashOf(2) });
    expect(await cache.get(hashOf(2))).toBeUndefined();
  });

  it('never lets a later negative displace a positive', async () => {
    const cache = new InMemoryVerdictCache({ negativeTtlMs: DAY });
    await cache.put(positive);
    await cache.put(negative);
    expect(await cache.get(hashOf(1))).toEqual(positive);
  });

  it('lets a later positive replace a negative', async () => {
    const cache = new InMemoryVerdictCache({ negativeTtlMs: DAY });
    await cache.put(negative);
    await cache.put(positive);
    expect(await cache.get(hashOf(1))).toEqual(positive);
  });

  it('answers nothing for a hash it has never seen', async () => {
    const cache = new InMemoryVerdictCache({ negativeTtlMs: DAY });
    expect(await cache.get(hashOf(9))).toBeUndefined();
  });

  it('refuses a negative lifetime that is not bounded and positive', () => {
    for (const bad of [0, -1, Number.POSITIVE_INFINITY, Number.NaN, MAX_NEGATIVE_TTL_MS + 1, Number.MAX_VALUE]) {
      expect(() => new InMemoryVerdictCache({ negativeTtlMs: bad })).toThrow(RangeError);
    }
  });

  it('counts every match classification, and only those, as positive', () => {
    expect(isPositive(positive)).toBe(true);
    expect(isPositive({ ...positive, classification: 'test' })).toBe(true);
    expect(isPositive({ ...positive, classification: 'harmful-abusive-material' })).toBe(true);
    expect(isPositive(negative)).toBe(false);
    expect(isPositive({ ...negative, classification: 'unavailable' })).toBe(false);
  });

  it('accepts a negative lifetime exactly at the ceiling of seven days', () => {
    expect(MAX_NEGATIVE_TTL_MS).toBe(7 * DAY);
    expect(() => new InMemoryVerdictCache({ negativeTtlMs: MAX_NEGATIVE_TTL_MS })).not.toThrow();
  });

  it('refuses a size bound that is not a positive integer', () => {
    for (const maxEntries of [0, -1, 1.5]) {
      expect(() => new InMemoryVerdictCache({ negativeTtlMs: DAY, maxEntries })).toThrow(RangeError);
    }
  });

  it('sweeps expired negatives before growing past its bound', async () => {
    const c = clock();
    const cache = new InMemoryVerdictCache({ negativeTtlMs: DAY, maxEntries: 3, now: c.now });
    for (const n of [1, 2, 3]) await cache.put({ ...negative, evidence: hashOf(n) });
    c.advance(DAY);
    await cache.put({ ...negative, evidence: hashOf(4) });
    expect(cache.size).toBe(1);
    expect(await cache.get(hashOf(4))).toBeDefined();
  });

  it('evicts the oldest negative, never a positive, when full', async () => {
    const cache = new InMemoryVerdictCache({ negativeTtlMs: DAY, maxEntries: 3 });
    await cache.put({ ...negative, evidence: hashOf(1) });
    await cache.put({ ...positive, evidence: hashOf(2) });
    await cache.put({ ...negative, evidence: hashOf(3) });
    await cache.put({ ...negative, evidence: hashOf(4) });
    expect(cache.size).toBe(3);
    expect(await cache.get(hashOf(1))).toBeUndefined();
    expect(await cache.get(hashOf(2))).toEqual({ ...positive, evidence: hashOf(2) });
    expect(await cache.get(hashOf(4))).toBeDefined();
  });

  it('drops a new negative rather than evict a positive, and still keeps a new positive', async () => {
    const cache = new InMemoryVerdictCache({ negativeTtlMs: DAY, maxEntries: 2 });
    await cache.put({ ...positive, evidence: hashOf(1) });
    await cache.put({ ...positive, evidence: hashOf(2) });
    await cache.put({ ...negative, evidence: hashOf(3) });
    expect(await cache.get(hashOf(3))).toBeUndefined();
    await cache.put({ ...positive, evidence: hashOf(4) });
    expect(cache.size).toBe(3);
    for (const n of [1, 2, 4]) expect(await cache.get(hashOf(n))).toBeDefined();
  });

  it('refreshes a re-stored negative without counting it twice', async () => {
    const cache = new InMemoryVerdictCache({ negativeTtlMs: DAY, maxEntries: 2 });
    await cache.put({ ...negative, evidence: hashOf(1) });
    await cache.put({ ...negative, evidence: hashOf(1) });
    await cache.put({ ...negative, evidence: hashOf(2) });
    expect(cache.size).toBe(2);
  });
});
