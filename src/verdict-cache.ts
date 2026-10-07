import type { PdqHash, Verdict, VerdictCache } from './contract.js';

export interface InMemoryVerdictCacheOptions {
  /**
   * How long a `no-known-match` stays trusted. A hash that is clean today
   * may be listed next month, so a negative that never expired would stop
   * the estate ever learning that about something already stored.
   */
  readonly negativeTtlMs: number;
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
  readonly #now: () => number;

  constructor(options: InMemoryVerdictCacheOptions) {
    if (!Number.isFinite(options.negativeTtlMs) || options.negativeTtlMs <= 0) {
      throw new RangeError('negativeTtlMs must be a positive, finite number of milliseconds');
    }
    this.#negativeTtlMs = options.negativeTtlMs;
    this.#now = options.now ?? Date.now;
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
    const existing = this.#entries.get(verdict.evidence);
    // A positive is never displaced, not even by a later negative for the
    // same hash: a listing is not withdrawn by one clean answer.
    if (existing !== undefined && isPositive(existing.verdict)) return Promise.resolve();
    const expiresAt = isPositive(verdict) ? Number.POSITIVE_INFINITY : this.#now() + this.#negativeTtlMs;
    this.#entries.set(verdict.evidence, { verdict, expiresAt });
    return Promise.resolve();
  }
}
