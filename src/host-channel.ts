import { buildVerdictsBody, MAX_BODY_BYTES, parsePendingBatch, PENDING_PATH, VERDICTS_PATH } from './channel-contract.js';
import type { PendingBatch } from './channel-contract.js';
import type { HostConfig } from './config.js';
import type { Assessment, PdqHash, PolicyContext } from './contract.js';
import type { RequestSigner } from './request-signer.js';
import type { FetchLike } from './arachnid-client.js';

/** What a log line may carry: fixed names and counts, never a value from a request or a secret. */
export type LogFields = Readonly<Record<string, string | number | boolean>>;
export type Logger = (event: string, fields: LogFields) => void;

export interface HostChannelOptions {
  readonly host: HostConfig;
  readonly assess: (hashes: readonly PdqHash[], context: PolicyContext) => Promise<readonly Assessment[]>;
  readonly signer: RequestSigner;
  readonly log: Logger;
  readonly fetch?: FetchLike;
  /** Must exceed the host's own hold, or every quiet poll would look like a failure. */
  readonly pollTimeoutMs: number;
  readonly postTimeoutMs: number;
  /** The least time between two polls that came back empty, so a host that answers at once is not spun on. */
  readonly minPollGapMs: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly now?: () => number;
}

export type RoundOutcome = 'empty' | 'answered' | 'failed';

/** Thrown for a host answer that breaks the channel contract; carries a fixed reason only. */
class ChannelError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'ChannelError';
  }
}

/**
 * The service's half of one host's channel: it dials, holds a poll open,
 * assesses and returns verdicts. Nothing here listens.
 */
export class HostChannel {
  readonly #options: HostChannelOptions;
  readonly #fetch: FetchLike;
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly #now: () => number;
  readonly #context: PolicyContext;
  readonly #stop = new AbortController();
  #loop: Promise<void> | undefined;

  constructor(options: HostChannelOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#sleep = options.sleep ?? abortableSleep;
    this.#now = options.now ?? Date.now;
    this.#context = { kind: options.host.kind, safety: options.host.safety };
  }

  start(): void {
    this.#loop ??= this.#run();
  }

  /** Stops polling, lets a batch already being answered finish, and resolves once the loop has ended. */
  async stop(): Promise<void> {
    this.#stop.abort();
    await this.#loop;
  }

  async #run(): Promise<void> {
    let failures = 0;
    while (!this.#stop.signal.aborted) {
      const started = this.#now();
      const outcome = await this.runOnce();
      if (this.#stop.signal.aborted) return;
      if (outcome === 'failed') {
        failures += 1;
        await this.#sleep(this.#backoff(failures), this.#stop.signal);
      } else {
        failures = 0;
        if (outcome === 'empty') {
          const wait = this.#options.minPollGapMs - (this.#now() - started);
          if (wait > 0) await this.#sleep(wait, this.#stop.signal);
        }
      }
    }
  }

  #backoff(failures: number): number {
    return Math.min(this.#options.backoffBaseMs * 2 ** (failures - 1), this.#options.backoffMaxMs);
  }

  /** One poll, and if it carried hashes, one answer. Never throws. */
  async runOnce(): Promise<RoundOutcome> {
    const host = this.#options.host.id;
    let batch: PendingBatch;
    try {
      batch = await this.#poll();
    } catch (error) {
      if (this.#stop.signal.aborted) return 'empty';
      this.#options.log('poll-failed', { host, reason: reasonOf(error) });
      return 'failed';
    }
    if (batch.hashes.length === 0) {
      // Entries that are not PDQ hashes get no verdict, which is a hold at
      // the host; saying so is the only trace of a host sending them.
      if (batch.skipped > 0) this.#options.log('batch-unanswerable', { host, skipped: batch.skipped });
      return 'empty';
    }

    let assessments: readonly Assessment[];
    try {
      assessments = await this.#options.assess(batch.hashes, this.#context);
    } catch {
      // A hash the service could not assess is answered `unavailable`, not
      // left out: the host holds either way, and an answer lets it retry.
      this.#options.log('assess-failed', { host, hashes: batch.hashes.length });
      assessments = batch.hashes.map(unavailableAssessment);
    }

    try {
      const accepted = await this.#post(batch.batch, assessments);
      this.#options.log(accepted ? 'batch-answered' : 'batch-expired', {
        host,
        answered: assessments.length,
        skipped: batch.skipped,
      });
      return 'answered';
    } catch (error) {
      this.#options.log('verdicts-failed', { host, reason: reasonOf(error) });
      return 'failed';
    }
  }

  async #poll(): Promise<PendingBatch> {
    const path = PENDING_PATH;
    const response = await this.#fetch(new URL(path, this.#options.host.endpoint).toString(), {
      method: 'GET',
      headers: { accept: 'application/json', ...this.#options.signer.sign('GET', path, '') },
      signal: AbortSignal.any([this.#stop.signal, AbortSignal.timeout(this.#options.pollTimeoutMs)]),
      redirect: 'error',
    });
    if (!response.ok) throw new ChannelError(`host-answered-${String(response.status)}`);
    const text = await response.text();
    if (text.length > MAX_BODY_BYTES) throw new ChannelError('response-too-large');
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ChannelError('response-not-json');
    }
    const batch = parsePendingBatch(payload);
    if (batch === undefined) throw new ChannelError('response-breaks-contract');
    return batch;
  }

  /** Resolves true when the host took the verdicts, false when it no longer holds the batch. */
  async #post(batch: string, assessments: readonly Assessment[]): Promise<boolean> {
    const path = VERDICTS_PATH;
    const body = buildVerdictsBody(batch, assessments);
    const response = await this.#fetch(new URL(path, this.#options.host.endpoint).toString(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...this.#options.signer.sign('POST', path, body),
      },
      body,
      signal: AbortSignal.timeout(this.#options.postTimeoutMs),
      redirect: 'error',
    });
    await response.arrayBuffer();
    if (response.status === 409) return false;
    if (!response.ok) throw new ChannelError(`host-answered-${String(response.status)}`);
    return true;
  }
}

function unavailableAssessment(hash: PdqHash): Assessment {
  return {
    hash,
    verdict: { classification: 'unavailable', source: 'safety-service', evidence: hash },
    decision: { action: 'hold', reason: 'unavailable' },
    audited: false,
  };
}

function reasonOf(error: unknown): string {
  if (error instanceof ChannelError) return error.reason;
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return 'timeout';
  return 'unreachable';
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
