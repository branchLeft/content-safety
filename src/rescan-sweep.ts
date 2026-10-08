import type { Assessment, PdqHash, PolicyContext, RescannableVerdictCache } from './contract.js';
import { assertBudget } from './deadline.js';
import { MAX_NEGATIVE_TTL_MS } from './verdict-cache.js';

/**
 * The longest gap between sweeps. It equals the longest a negative may be
 * trusted, so no stored hash goes unasked for longer than a negative may
 * stand.
 */
export const MAX_RESCAN_INTERVAL_MS = MAX_NEGATIVE_TTL_MS;

/** A stored object, known to the sweep by its hash and an opaque reference only. */
export interface StoredObject {
  readonly hash: PdqHash;
  /** Handed back untouched to `withdraw`; never inspected here. */
  readonly ref: string;
  readonly context: PolicyContext;
}

export interface StoredHashPage {
  readonly objects: readonly StoredObject[];
  /** Absent on the last page. */
  readonly next?: string;
}

/** Hashes only, never bytes: this is all the sweep can see of storage. */
export interface StoredHashSource {
  page(cursor: string | undefined, limit: number): Promise<StoredHashPage>;
}

export interface SweepReport {
  readonly examined: number;
  readonly withdrawn: number;
  /** Refused objects whose withdrawal threw; they are retried next sweep. */
  readonly withdrawFailed: number;
  /** Hashes the hash source could not answer for; they stay as they are and are asked again. */
  readonly unanswered: number;
}

export interface RescanSweepOptions {
  readonly source: StoredHashSource;
  /** The cache the assessing service reads, so a stale negative cannot answer for the sweep. */
  readonly cache: RescannableVerdictCache;
  readonly assess: (hashes: readonly PdqHash[], context: PolicyContext) => Promise<readonly Assessment[]>;
  /** Takes the object out of its served location. Must be idempotent. */
  readonly withdraw: (object: StoredObject, assessment: Assessment) => Promise<void>;
  readonly intervalMs: number;
  /** Objects per page read from storage. Incidental. */
  readonly pageSize?: number;
  readonly onError?: (error: unknown) => void;
}

const DEFAULT_PAGE_SIZE = 500;

/**
 * Re-asks the hash source about every stored hash, so something clean when
 * stored and listed since is found. A refusal is treated exactly as one at
 * upload; an `unavailable` or a hold withdraws nothing, because an absent
 * answer says nothing about the object.
 */
export class RescanSweep {
  readonly #options: RescanSweepOptions;
  readonly #pageSize: number;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<SweepReport> | undefined;

  constructor(options: RescanSweepOptions) {
    assertBudget('intervalMs', options.intervalMs);
    if (options.intervalMs > MAX_RESCAN_INTERVAL_MS) {
      throw new RangeError(`intervalMs must be at most ${String(MAX_RESCAN_INTERVAL_MS)}ms`);
    }
    const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(pageSize) || pageSize < 1) {
      throw new RangeError('pageSize must be a positive integer');
    }
    this.#options = options;
    this.#pageSize = pageSize;
  }

  /** One full pass. A pass already in flight is joined, never doubled. */
  sweep(): Promise<SweepReport> {
    this.#running ??= this.#pass().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  start(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => {
      this.sweep().catch((error: unknown) => this.#options.onError?.(error));
    }, this.#options.intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async #pass(): Promise<SweepReport> {
    let examined = 0;
    let withdrawn = 0;
    let withdrawFailed = 0;
    let unanswered = 0;
    let cursor: string | undefined;
    do {
      const page = await this.#options.source.page(cursor, this.#pageSize);
      examined += page.objects.length;
      for (const group of groupByContext(page.objects)) {
        const hashes = [...new Set(group.objects.map((o) => o.hash))];
        // Dropping first is what makes this a re-submission: a still-valid
        // cached negative would otherwise answer without asking anyone.
        for (const hash of hashes) await this.#options.cache.dropNegative(hash);
        const byHash = new Map<PdqHash, Assessment>();
        for (const a of await this.#options.assess(hashes, group.context)) byHash.set(a.hash, a);
        for (const object of group.objects) {
          const assessment = byHash.get(object.hash);
          if (assessment === undefined || assessment.verdict.classification === 'unavailable') {
            unanswered += 1;
          } else if (assessment.decision.action === 'refuse') {
            try {
              await this.#options.withdraw(object, assessment);
              withdrawn += 1;
            } catch (error) {
              withdrawFailed += 1;
              this.#options.onError?.(error);
            }
          }
        }
      }
      cursor = page.next;
    } while (cursor !== undefined);
    return { examined, withdrawn, withdrawFailed, unanswered };
  }
}

function groupByContext(
  objects: readonly StoredObject[]
): readonly { context: PolicyContext; objects: StoredObject[] }[] {
  const groups = new Map<string, { context: PolicyContext; objects: StoredObject[] }>();
  for (const object of objects) {
    const key = JSON.stringify([object.context.kind, object.context.safety]);
    const group = groups.get(key) ?? { context: object.context, objects: [] };
    group.objects.push(object);
    groups.set(key, group);
  }
  return [...groups.values()];
}
