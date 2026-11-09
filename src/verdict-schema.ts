import { BATCH_ID, CHANNEL_VERSION } from './channel-contract.js';
import type { VerdictEntry, VerdictsBody } from './channel-contract.js';
import type { Decision, HoldReason, MatchType, PdqHash, ResponseStep, Verdict } from './contract.js';
import { parsePdqHash } from './pdq-hash.js';

/**
 * The reader of a verdicts body: what a host (or a conformance test for one)
 * runs on the service's answer. Each table is a `Record` over its union, so
 * a value added to the union and not here is a compile error, not a
 * verdict a host silently refuses.
 */
const CLASSIFICATIONS: Readonly<Record<Verdict['classification'], true>> = {
  csam: true,
  'harmful-abusive-material': true,
  test: true,
  'no-known-match': true,
  unavailable: true,
};
const MATCH_TYPES: Readonly<Record<MatchType, true>> = { exact: true, near: true };
const HOLD_REASONS: Readonly<Record<HoldReason, true>> = {
  unavailable: true,
  'context-rejected': true,
  'audit-unavailable': true,
};
const STEPS: Readonly<Record<ResponseStep, true>> = {
  withhold: true,
  freeze: true,
  seal: true,
  'start-reporting-clock': true,
  page: true,
  'kill-slot-quietly': true,
  'keep-site-serving': true,
};

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnly(value: Obj, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function member<T extends string>(table: Readonly<Record<T, true>>, value: unknown): value is T {
  return typeof value === 'string' && Object.hasOwn(table, value);
}

function parseDecision(value: unknown): Decision | undefined {
  if (!isObject(value)) return undefined;
  if (value['action'] === 'allow') return hasOnly(value, ['action']) ? { action: 'allow' } : undefined;
  if (value['action'] === 'hold') {
    const reason = value['reason'];
    return hasOnly(value, ['action', 'reason']) && member(HOLD_REASONS, reason) ? { action: 'hold', reason } : undefined;
  }
  if (value['action'] !== 'refuse') return undefined;
  const { tier, irreversible, control, steps } = value;
  if (!hasOnly(value, ['action', 'tier', 'irreversible', 'control', 'steps'])) return undefined;
  if (tier !== 'one' && tier !== 'two') return undefined;
  if (typeof irreversible !== 'boolean' || typeof control !== 'boolean') return undefined;
  if (!Array.isArray(steps) || !(steps as readonly unknown[]).every((step) => member(STEPS, step))) return undefined;
  return { action: 'refuse', tier, irreversible, control, steps: [...(steps as readonly ResponseStep[])] };
}

function parseEntry(value: unknown): VerdictEntry | undefined {
  if (!isObject(value)) return undefined;
  if (!hasOnly(value, ['hash', 'classification', 'matchType', 'source', 'decision', 'audited'])) return undefined;
  const hash = parsePdqHash(value['hash']);
  const { classification, matchType, source, audited } = value;
  const decision = parseDecision(value['decision']);
  if (hash === undefined || decision === undefined) return undefined;
  if (!member(CLASSIFICATIONS, classification)) return undefined;
  if (typeof source !== 'string' || source.length === 0) return undefined;
  if (typeof audited !== 'boolean') return undefined;
  if (matchType === undefined) return { hash, classification, source, decision, audited };
  if (!member(MATCH_TYPES, matchType)) return undefined;
  return { hash, classification, matchType, source, decision, audited };
}

/**
 * Strict on purpose: one entry that does not read, a field the version does
 * not name, or a wrong `v` makes the whole body unreadable. An unreadable
 * answer is no answer, and a host holds on no answer.
 */
export function parseVerdictsBody(payload: unknown): VerdictsBody | undefined {
  if (!isObject(payload) || !hasOnly(payload, ['v', 'batch', 'verdicts'])) return undefined;
  const { v, batch, verdicts } = payload;
  if (v !== CHANNEL_VERSION || typeof batch !== 'string' || !BATCH_ID.test(batch)) return undefined;
  if (!Array.isArray(verdicts)) return undefined;
  const entries: VerdictEntry[] = [];
  for (const raw of verdicts as readonly unknown[]) {
    const entry = parseEntry(raw);
    if (entry === undefined) return undefined;
    entries.push(entry);
  }
  return { v: CHANNEL_VERSION, batch, verdicts: entries };
}

/**
 * The verdict for each hash a host offered under `batch`, keyed by the asked
 * hash. A body for another batch answers nothing. A hash that was not offered
 * is ignored, and a hash named twice is dropped, because two answers to one
 * question settle neither. A hash absent from the result has no verdict.
 */
export function answersFor(
  body: VerdictsBody,
  batch: string,
  offered: readonly PdqHash[]
): ReadonlyMap<PdqHash, VerdictEntry> {
  const answers = new Map<PdqHash, VerdictEntry>();
  if (body.batch !== batch) return answers;
  const asked = new Set<PdqHash>(offered);
  const repeated = new Set<PdqHash>();
  for (const entry of body.verdicts) {
    if (!asked.has(entry.hash)) continue;
    if (answers.has(entry.hash)) repeated.add(entry.hash);
    answers.set(entry.hash, entry);
  }
  for (const hash of repeated) answers.delete(hash);
  return answers;
}

/**
 * The only way a verdict lets an upload through: a definitive "no known
 * match" that the service also turned into an allow. Every other
 * classification, every hold and refusal, and a pair that disagrees, is not
 * a pass.
 */
export function admits(entry: VerdictEntry): boolean {
  return entry.classification === 'no-known-match' && entry.decision.action === 'allow';
}

/** What a host does with a hash: true only when a verdict arrived and admits it. A hash with no verdict is not a pass. */
export function mayPass(answers: ReadonlyMap<PdqHash, VerdictEntry>, hash: PdqHash): boolean {
  const entry = answers.get(hash);
  return entry !== undefined && admits(entry);
}
