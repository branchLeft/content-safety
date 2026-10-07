import { describe, expect, it } from 'vitest';
import type { Verdict } from '../src/contract.js';
import { InMemoryVerdictCache, isPositive } from '../src/verdict-cache.js';
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
    for (const bad of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
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
});
