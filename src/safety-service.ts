import { toAuditRecord } from './audit.js';
import type { AuditSink, BatchCheck, Decision, PdqHash, Policy, PolicyContext, Verdict } from './contract.js';

export interface Assessment {
  readonly hash: PdqHash;
  readonly verdict: Verdict;
  readonly decision: Decision;
}

export interface SafetyServiceOptions {
  readonly check: BatchCheck<PdqHash>;
  readonly policy: Policy;
  readonly audit: AuditSink;
  readonly now?: () => Date;
}

/**
 * Hashes in, one decision per hash out, every one of them audited. An
 * allow that could not be recorded becomes a hold: publishing must never
 * be the outcome of a failure. A refusal or hold stands either way.
 */
export class SafetyService {
  readonly #check: BatchCheck<PdqHash>;
  readonly #policy: Policy;
  readonly #audit: AuditSink;
  readonly #now: () => Date;

  constructor(options: SafetyServiceOptions) {
    if (!options.check.blocking || options.check.kind !== 'media') {
      throw new TypeError('the hash route takes a blocking media check only');
    }
    this.#check = options.check;
    this.#policy = options.policy;
    this.#audit = options.audit;
    this.#now = options.now ?? (() => new Date());
  }

  async assess(hashes: readonly PdqHash[], context: PolicyContext): Promise<readonly Assessment[]> {
    const verdicts = await this.#check.runBatch(hashes);
    return Promise.all(
      hashes.map(async (hash, i) => {
        const verdict = verdicts[i] ?? { classification: 'unavailable', source: 'safety-service', evidence: hash };
        const decided = this.#policy.decide(verdict, context);
        try {
          await this.#audit.record(toAuditRecord(this.#now(), verdict, decided, context));
          return { hash, verdict, decision: decided };
        } catch {
          const decision: Decision =
            decided.action === 'allow' ? { action: 'hold', reason: 'audit-unavailable' } : decided;
          return { hash, verdict, decision };
        }
      })
    );
  }
}
