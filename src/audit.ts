import type { AuditRecord, AuditSink, Decision, PolicyContext, Verdict } from './contract.js';
import { parsePdqHash } from './pdq-hash.js';

/**
 * Builds a record field by field from the verdict, never by spreading it:
 * whatever else a verdict object happens to carry cannot reach the trail.
 * The hash is re-validated, so a value that is not a PDQ hash cannot either.
 */
export function toAuditRecord(at: Date, verdict: Verdict, decision: Decision, context: PolicyContext): AuditRecord {
  const hash = parsePdqHash(verdict.evidence);
  if (hash === undefined) {
    throw new TypeError('refusing to audit evidence that is not a PDQ hash');
  }
  return {
    at: at.toISOString(),
    estate: context.kind,
    hash,
    classification: verdict.classification,
    matchType: verdict.matchType ?? null,
    source: verdict.source,
    decision: copyDecision(decision),
  };
}

function copyDecision(decision: Decision): Decision {
  switch (decision.action) {
    case 'allow':
      return { action: 'allow' };
    case 'hold':
      return { action: 'hold', reason: decision.reason };
    case 'refuse':
      return {
        action: 'refuse',
        tier: decision.tier,
        irreversible: decision.irreversible,
        control: decision.control,
        steps: [...decision.steps],
      };
  }
}

/** Writes one JSON line per record to an injected writer, such as an append-only file. */
export class JsonLinesAuditSink implements AuditSink {
  readonly #write: (line: string) => Promise<void> | void;

  constructor(write: (line: string) => Promise<void> | void) {
    this.#write = write;
  }

  async record(entry: AuditRecord): Promise<void> {
    await this.#write(`${JSON.stringify(entry)}\n`);
  }
}
