import type { BatchCheck, PdqHash, PdqLookup, Verdict, VerdictCache } from './contract.js';
import { assertBudget, withDeadline } from './deadline.js';

export const PDQ_CHECK_SOURCE = 'arachnid-shield-pdq';

export interface PdqKnownMaterialCheckOptions {
  readonly lookup: PdqLookup;
  readonly cache: VerdictCache;
  /** The whole budget for one lookup round trip, after which every hash still waiting is `unavailable`. */
  readonly timeoutMs: number;
  /** Hashes per request. Incidental: the published contract names no limit. */
  readonly maxBatchSize?: number;
  /** Budget for one cache read or write. A read past it is a miss; a write past it is dropped. */
  readonly cacheTimeoutMs?: number;
}

const DEFAULT_MAX_BATCH = 100;
const DEFAULT_CACHE_TIMEOUT_MS = 250;

/**
 * Hash-only by construction: its subject is a `PdqHash`, so there is no
 * way to hand it bytes. Blocking, because a hash match is a comparison
 * against a known set rather than a judgement.
 */
export class PdqKnownMaterialCheck implements BatchCheck<PdqHash> {
  readonly kind = 'media' as const;
  readonly blocking = true as const;
  readonly #lookup: PdqLookup;
  readonly #cache: VerdictCache;
  readonly #timeoutMs: number;
  readonly #cacheTimeoutMs: number;
  readonly #maxBatch: number;

  constructor(options: PdqKnownMaterialCheckOptions) {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new RangeError('timeoutMs must be a positive, finite number of milliseconds');
    }
    const maxBatch = options.maxBatchSize ?? DEFAULT_MAX_BATCH;
    if (!Number.isInteger(maxBatch) || maxBatch < 1) {
      throw new RangeError('maxBatchSize must be a positive integer');
    }
    this.#lookup = options.lookup;
    this.#cache = options.cache;
    this.#timeoutMs = options.timeoutMs;
    this.#cacheTimeoutMs = assertBudget('cacheTimeoutMs', options.cacheTimeoutMs ?? DEFAULT_CACHE_TIMEOUT_MS);
    this.#maxBatch = maxBatch;
  }

  async run(subject: PdqHash): Promise<Verdict> {
    const [verdict] = await this.runBatch([subject]);
    return verdict ?? unavailable(subject);
  }

  async runBatch(subjects: readonly PdqHash[]): Promise<readonly Verdict[]> {
    const known = new Map<PdqHash, Verdict>();
    const misses: PdqHash[] = [];
    for (const hash of new Set(subjects)) {
      const cached = await this.#safeCacheGet(hash);
      if (cached === undefined) misses.push(hash);
      else known.set(hash, cached);
    }
    const chunks: PdqHash[][] = [];
    for (let i = 0; i < misses.length; i += this.#maxBatch) {
      chunks.push(misses.slice(i, i + this.#maxBatch));
    }
    // Concurrent, so a large batch is bounded by one timeout rather than one per chunk.
    const answers = await Promise.all(chunks.map((chunk) => this.#ask(chunk)));
    for (const verdict of answers.flat()) {
      known.set(verdict.evidence, verdict);
      await this.#safeCachePut(verdict);
    }
    return subjects.map((hash) => known.get(hash) ?? unavailable(hash));
  }

  async #ask(hashes: readonly PdqHash[]): Promise<readonly Verdict[]> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Aborting is not enough on its own: a lookup that ignores its signal
    // would still hang the caller, so the race resolves regardless.
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, this.#timeoutMs);
    });
    try {
      const answered = await Promise.race([this.#lookup.lookup(hashes, controller.signal), timedOut]);
      if (answered === null) return hashes.map(unavailable);
      return hashes.map((hash) => {
        const result = answered.get(hash);
        if (result === undefined) return unavailable(hash);
        const verdict: Verdict = {
          classification: result.classification,
          source: PDQ_CHECK_SOURCE,
          evidence: hash,
        };
        return result.matchType === undefined ? verdict : { ...verdict, matchType: result.matchType };
      });
    } catch {
      return hashes.map(unavailable);
    } finally {
      clearTimeout(timer);
    }
  }

  async #safeCacheGet(hash: PdqHash): Promise<Verdict | undefined> {
    try {
      return await withDeadline(this.#cache.get(hash), this.#cacheTimeoutMs, 'cache read');
    } catch {
      return undefined;
    }
  }

  async #safeCachePut(verdict: Verdict): Promise<void> {
    try {
      await withDeadline(this.#cache.put(verdict), this.#cacheTimeoutMs, 'cache write');
    } catch {
      // A cache that cannot store only costs a repeat lookup next time.
    }
  }
}

function unavailable(hash: PdqHash): Verdict {
  return { classification: 'unavailable', source: PDQ_CHECK_SOURCE, evidence: hash };
}
