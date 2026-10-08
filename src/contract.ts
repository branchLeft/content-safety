/**
 * The interfaces every other module implements or consumes. The Check,
 * Verdict and Policy shapes mirror the seam the scanning storage decorator
 * already exposes on the host side, so a verdict produced here means the
 * same thing there.
 */

import type { SafetySpec, TenantKind } from '@branchleft/ghost-platform-render-core';

declare const brand: unique symbol;

/**
 * A 256-bit PDQ perceptual hash, base64-encoded: exactly 32 bytes once
 * decoded. Only `parsePdqHash` produces one, so a value of this type can
 * never be image bytes, a thumbnail or any other blob.
 */
export type PdqHash = string & { readonly [brand]: 'PdqHash' };

export type Classification = 'csam' | 'harmful-abusive-material' | 'test' | 'no-known-match';

export type MatchType = 'exact' | 'near';

/** Anything other than a definitive answer from the hash source. */
export type Unavailable = 'unavailable';

export interface Verdict {
  readonly classification: Classification | Unavailable;
  readonly matchType?: MatchType;
  readonly confidence?: number;
  readonly source: string;
  /** The digest the verdict is about. Never bytes. */
  readonly evidence: PdqHash;
}

/**
 * `run` must not throw and must answer within its own timeout: a failure
 * of any kind is an `unavailable` verdict, which the policy turns into a
 * hold, never an allow.
 */
export interface Check<Subject> {
  readonly kind: 'media' | 'text';
  readonly blocking: boolean;
  run(subject: Subject): Promise<Verdict>;
}

/** A Check that can also answer many subjects in one round trip. */
export interface BatchCheck<Subject> extends Check<Subject> {
  runBatch(subjects: readonly Subject[]): Promise<readonly Verdict[]>;
}

/**
 * Taken from the tenant descriptor as given: the estate comes from its
 * `kind`, the near/exact axis from its `safety`. Neither is redefined here.
 */
export interface PolicyContext {
  readonly kind: TenantKind;
  readonly safety: SafetySpec;
}

/**
 * What a decision asks the rest of the platform to do. Only the tier-two
 * steps are irreversible, and only tier two differs between estates.
 */
export type ResponseStep =
  | 'withhold'
  | 'freeze'
  | 'seal'
  | 'start-reporting-clock'
  | 'page'
  | 'kill-slot-quietly'
  | 'keep-site-serving';

export type HoldReason = 'unavailable' | 'context-rejected' | 'audit-unavailable';

export type Decision =
  | { readonly action: 'allow' }
  | { readonly action: 'hold'; readonly reason: HoldReason }
  | {
      readonly action: 'refuse';
      readonly tier: 'one' | 'two';
      readonly irreversible: boolean;
      /** True for the supplier's `test` classification, so alarms can route quietly. */
      readonly control: boolean;
      readonly steps: readonly ResponseStep[];
    };

export interface Policy {
  decide(verdict: Verdict, context: PolicyContext): Decision;
}

/**
 * Shared by every host the service answers for. A positive is kept for
 * ever; a negative only for a bounded lifetime; `unavailable` is never
 * cached, because it is not an answer.
 */
export interface VerdictCache {
  get(hash: PdqHash): Promise<Verdict | undefined>;
  put(verdict: Verdict): Promise<void>;
}

/**
 * A cache the re-scan sweep can force to ask again. Only a negative is
 * dropped: a positive is a listing and is never withdrawn by a sweep.
 */
export interface RescannableVerdictCache extends VerdictCache {
  dropNegative(hash: PdqHash): Promise<void>;
}

/** One line of the audit trail. Digests, verdicts and decisions only. */
export interface AuditRecord {
  readonly at: string;
  readonly estate: TenantKind;
  readonly hash: PdqHash;
  readonly classification: Verdict['classification'];
  readonly matchType: MatchType | null;
  readonly source: string;
  readonly decision: Decision;
}

export interface AuditSink {
  record(entry: AuditRecord): Promise<void>;
}

/**
 * One hash's outcome. `audited: false` means no record of this decision
 * was written: the decision still stands (an allow has already become a
 * hold), and the caller must raise it, because a refusal without its
 * retained record is a gap in what the platform can later account for.
 */
export interface Assessment {
  readonly hash: PdqHash;
  readonly verdict: Verdict;
  readonly decision: Decision;
  readonly audited: boolean;
}

/** The hash source the media check asks. Implemented over HTTP by `ArachnidPdqClient`. */
export interface PdqLookup {
  /**
   * Answers each hash it can. A hash missing from the result has no
   * verdict. May reject or hang; the caller bounds it.
   */
  lookup(hashes: readonly PdqHash[], signal: AbortSignal): Promise<ReadonlyMap<PdqHash, LookupResult>>;
}

export interface LookupResult {
  readonly classification: Classification;
  readonly matchType?: MatchType;
}
