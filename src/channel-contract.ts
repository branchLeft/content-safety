import { copyDecision } from './audit.js';
import type { Assessment, Decision, MatchType, PdqHash, Verdict } from './contract.js';
import { parsePdqHash } from './pdq-hash.js';

export const CHANNEL_VERSION = 1;

/** The host answers a held poll here with the hashes waiting for a verdict. */
export const PENDING_PATH = '/safety/v1/pending';

/** The service returns the verdicts for one batch here. */
export const VERDICTS_PATH = '/safety/v1/verdicts';

/** Most hashes in one batch, so a body stays well inside `MAX_BODY_BYTES`. */
export const MAX_BATCH_HASHES = 500;

export const MAX_BODY_BYTES = 256 * 1024;

const BATCH_ID = /^[A-Za-z0-9._-]{16,128}$/;

export interface PendingBatch {
  /** Names the lease the host holds on these hashes; echoed back with the verdicts. */
  readonly batch: string;
  readonly hashes: readonly PdqHash[];
  /** Entries dropped as not a PDQ hash, a repeat, or past the batch cap. They get no verdict. */
  readonly skipped: number;
}

/**
 * A value that is not a PDQ hash is dropped here: left in, it would fail
 * the whole upstream request and make every hash in it `unavailable`.
 */
export function parsePendingBatch(payload: unknown): PendingBatch | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined;
  const body = payload as { v?: unknown; batch?: unknown; hashes?: unknown };
  if (body.v !== CHANNEL_VERSION || !Array.isArray(body.hashes)) return undefined;
  if (body.hashes.length === 0) return { batch: '', hashes: [], skipped: 0 };
  if (typeof body.batch !== 'string' || !BATCH_ID.test(body.batch)) return undefined;
  const seen = new Set<PdqHash>();
  const hashes: PdqHash[] = [];
  let skipped = 0;
  for (const entry of body.hashes as readonly unknown[]) {
    const hash = parsePdqHash(entry);
    if (hash === undefined || seen.has(hash) || hashes.length >= MAX_BATCH_HASHES) {
      skipped += 1;
      continue;
    }
    seen.add(hash);
    hashes.push(hash);
  }
  return { batch: body.batch, hashes, skipped };
}

/** One hash's outcome as the host receives it. Nothing else of the assessment is sent. */
export interface VerdictEntry {
  readonly hash: PdqHash;
  readonly classification: Verdict['classification'];
  readonly matchType?: MatchType;
  readonly source: string;
  readonly decision: Decision;
  readonly audited: boolean;
}

export interface VerdictsBody {
  readonly v: typeof CHANNEL_VERSION;
  readonly batch: string;
  readonly verdicts: readonly VerdictEntry[];
}

/**
 * Built field by field, never by spreading, so nothing else an assessment
 * carries reaches the host; the hash is re-validated too.
 */
export function buildVerdictsBody(batch: string, assessments: readonly Assessment[]): string {
  const verdicts = assessments.map((assessment): VerdictEntry => {
    const hash = parsePdqHash(assessment.hash);
    if (hash === undefined) throw new TypeError('refusing to return a verdict about a value that is not a PDQ hash');
    const { verdict } = assessment;
    const entry = {
      hash,
      classification: verdict.classification,
      source: verdict.source,
      decision: copyDecision(assessment.decision),
      audited: assessment.audited,
    };
    return verdict.matchType === undefined ? entry : { ...entry, matchType: verdict.matchType };
  });
  const body: VerdictsBody = { v: CHANNEL_VERSION, batch, verdicts };
  const text = JSON.stringify(body);
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    throw new RangeError('a verdicts body must not exceed the channel body limit');
  }
  return text;
}
