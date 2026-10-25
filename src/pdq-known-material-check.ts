import type { BatchCheck, PdqHash, PdqLookup, Verdict, VerdictCache } from './contract.js';
import { assertBudget, millisecondsRemaining, withDeadline } from './deadline.js';

export const PDQ_CHECK_SOURCE = 'arachnid-shield-pdq';

export interface PdqKnownMaterialCheckOptions {
  readonly lookup: PdqLookup;
  readonly cache: VerdictCache;
  /**
   * The whole budget for one `runBatch` call, covering cache reads, the lookup and cache writes. Every hash
   * still waiting when it runs out is `unavailable`.
   */
  readonly timeoutMs: number;
  /** Hashes per request. Incidental: the published contract names no limit. */
  readonly maxBatchSize?: number;
  /**
   * Budget for one cache read or write, capped by what remains of `timeoutMs`. A read past it is a miss;
   * a write past it is dropped.
   */
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
    const deadline = performance.now() + this.#timeoutMs;
    const known = new Map<PdqHash, Verdict>();
    const unique = [...new Set(subjects)];
    // Concurrent, so a hung cache costs one budget for the whole batch, not one per hash.
    const cached = await Promise.all(unique.map((hash) => this.#safeCacheGet(hash, deadline)));
    const misses: PdqHash[] = [];
    unique.forEach((hash, index) => {
      const verdict = cached[index];
      if (verdict === undefined) misses.push(hash);
      else known.set(hash, verdict);
    });
    const chunks: PdqHash[][] = [];
    for (let i = 0; i < misses.length; i += this.#maxBatch) {
      chunks.push(misses.slice(i, i + this.#maxBatch));
    }
    if (chunks.length > 0) {
      const lookupBudget = millisecondsRemaining(deadline);
      if (lookupBudget > 0) {
        // Concurrent, so a large batch is bounded by one budget rather than one per chunk.
        const answers = await Promise.all(chunks.map((chunk) => this.#ask(chunk, lookupBudget)));
        const verdicts = answers.flat();
        for (const verdict of verdicts) known.set(verdict.evidence, verdict);
        await Promise.all(verdicts.map((verdict) => this.#safeCachePut(verdict, deadline)));
      }
    }
    return subjects.map((hash) => known.get(hash) ?? unavailable(hash));
  }

  async #ask(hashes: readonly PdqHash[], budgetMs: number): Promise<readonly Verdict[]> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Aborting is not enough on its own: a lookup that ignores its signal
    // would still hang the caller, so the race resolves regardless.
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, budgetMs);
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

  async #safeCacheGet(hash: PdqHash, deadline: number): Promise<Verdict | undefined> {
    const budgetMs = millisecondsRemaining(deadline, this.#cacheTimeoutMs);
    if (budgetMs === 0) return undefined;
    try {
      return await withDeadline(this.#cache.get(hash), budgetMs, 'cache read');
    } catch {
      return undefined;
    }
  }

  async #safeCachePut(verdict: Verdict, deadline: number): Promise<void> {
    const budgetMs = millisecondsRemaining(deadline, this.#cacheTimeoutMs);
    if (budgetMs === 0) return;
    try {
      await withDeadline(this.#cache.put(verdict), budgetMs, 'cache write');
    } catch {
      // A cache that cannot store only costs a repeat lookup next time.
    }
  }
}

function unavailable(hash: PdqHash): Verdict {
  return { classification: 'unavailable', source: PDQ_CHECK_SOURCE, evidence: hash };
}
