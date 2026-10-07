import { toAuditRecord } from './audit.js';
import type {
  Assessment,
  AuditSink,
  BatchCheck,
  Decision,
  PdqHash,
  Policy,
  PolicyContext,
  Verdict,
} from './contract.js';
import { assertBudget, withDeadline } from './deadline.js';

export interface SafetyServiceOptions {
  readonly check: BatchCheck<PdqHash>;
  readonly policy: Policy;
  readonly audit: AuditSink;
  /** Budget for one audit write; past it, the write counts as failed. */
  readonly auditTimeoutMs?: number;
  readonly now?: () => Date;
}

const DEFAULT_AUDIT_TIMEOUT_MS = 1000;

/**
 * Hashes in, one decision per hash out. An allow that could not be
 * recorded becomes a hold: publishing must never be the outcome of a
 * failure. A refusal or a hold stands, and `audited: false` says so.
 */
export class SafetyService {
  readonly #check: BatchCheck<PdqHash>;
  readonly #policy: Policy;
  readonly #audit: AuditSink;
  readonly #auditTimeoutMs: number;
  readonly #now: () => Date;

  constructor(options: SafetyServiceOptions) {
    if (!options.check.blocking || options.check.kind !== 'media') {
      throw new TypeError('the hash route takes a blocking media check only');
    }
    this.#check = options.check;
    this.#policy = options.policy;
    this.#audit = options.audit;
    this.#auditTimeoutMs = assertBudget('auditTimeoutMs', options.auditTimeoutMs ?? DEFAULT_AUDIT_TIMEOUT_MS);
    this.#now = options.now ?? (() => new Date());
  }

  async assess(hashes: readonly PdqHash[], context: PolicyContext): Promise<readonly Assessment[]> {
    const verdicts = await this.#check.runBatch(hashes);
    return Promise.all(
      hashes.map(async (hash, i): Promise<Assessment> => {
        const verdict = verdictFor(hash, verdicts[i]);
        const decided = this.#policy.decide(verdict, context);
        try {
          await withDeadline(
            this.#audit.record(toAuditRecord(this.#now(), verdict, decided, context)),
            this.#auditTimeoutMs,
            'audit write'
          );
          return { hash, verdict, decision: decided, audited: true };
        } catch {
          const decision: Decision =
            decided.action === 'allow' ? { action: 'hold', reason: 'audit-unavailable' } : decided;
          return { hash, verdict, decision, audited: false };
        }
      })
    );
  }
}

/** A verdict about some other hash is no verdict about this one. */
function verdictFor(hash: PdqHash, verdict: Verdict | undefined): Verdict {
  if (verdict !== undefined && verdict.evidence === hash) return verdict;
  return { classification: 'unavailable', source: 'safety-service', evidence: hash };
}
