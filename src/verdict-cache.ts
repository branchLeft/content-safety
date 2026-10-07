import type { PdqHash, Verdict, VerdictCache } from './contract.js';

/**
 * The longest a `no-known-match` may be trusted: seven days. A hash that is
 * clean today may be listed next week, and the re-scan sweep only catches
 * what the cache lets through, so a longer lifetime is refused outright
 * rather than left to whoever configures it.
 */
export const MAX_NEGATIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const DEFAULT_MAX_ENTRIES = 100_000;

export interface InMemoryVerdictCacheOptions {
  readonly negativeTtlMs: number;
  /** Bounds the negatives held. Positives are never evicted, so they may exceed it. */
  readonly maxEntries?: number;
  readonly now?: () => number;
}

interface Entry {
  readonly verdict: Verdict;
  readonly expiresAt: number;
}

export function isPositive(verdict: Verdict): boolean {
  return verdict.classification !== 'no-known-match' && verdict.classification !== 'unavailable';
}

/**
 * One instance serves every host, which is what makes it shared. Where it
 * is stored is incidental; a durable store implements the same interface.
 */
export class InMemoryVerdictCache implements VerdictCache {
  readonly #entries = new Map<PdqHash, Entry>();
  readonly #negativeTtlMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;

  constructor(options: InMemoryVerdictCacheOptions) {
    const ttl = options.negativeTtlMs;
    if (!Number.isFinite(ttl) || ttl <= 0 || ttl > MAX_NEGATIVE_TTL_MS) {
      throw new RangeError(`negativeTtlMs must be positive and at most ${String(MAX_NEGATIVE_TTL_MS)}ms`);
    }
    const max = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (!Number.isInteger(max) || max < 1) {
      throw new RangeError('maxEntries must be a positive integer');
    }
    this.#negativeTtlMs = ttl;
    this.#maxEntries = max;
    this.#now = options.now ?? Date.now;
  }

  get size(): number {
    return this.#entries.size;
  }

  get(hash: PdqHash): Promise<Verdict | undefined> {
    const entry = this.#entries.get(hash);
    if (entry === undefined) return Promise.resolve(undefined);
    if (this.#now() >= entry.expiresAt) {
      this.#entries.delete(hash);
      return Promise.resolve(undefined);
    }
    return Promise.resolve(entry.verdict);
  }

  put(verdict: Verdict): Promise<void> {
    if (verdict.classification === 'unavailable') return Promise.resolve();
    const hash = verdict.evidence;
    const existing = this.#entries.get(hash);
    // A positive is never displaced, not even by a later negative for the
    // same hash: a listing is not withdrawn by one clean answer.
    if (existing !== undefined && isPositive(existing.verdict)) return Promise.resolve();
    const positive = isPositive(verdict);
    this.#entries.delete(hash);
    if (this.#entries.size >= this.#maxEntries && !this.#makeRoom() && !positive) {
      // Full of positives: dropping a negative only costs a repeat lookup.
      return Promise.resolve();
    }
    const expiresAt = positive ? Number.POSITIVE_INFINITY : this.#now() + this.#negativeTtlMs;
    this.#entries.set(hash, { verdict, expiresAt });
    return Promise.resolve();
  }

  /** Frees one slot: every expired entry first, else the oldest negative. */
  #makeRoom(): boolean {
    const now = this.#now();
    for (const [hash, entry] of this.#entries) {
      if (now >= entry.expiresAt) this.#entries.delete(hash);
    }
    if (this.#entries.size < this.#maxEntries) return true;
    for (const [hash, entry] of this.#entries) {
      if (!isPositive(entry.verdict)) {
        this.#entries.delete(hash);
        return true;
      }
    }
    return false;
  }
}
