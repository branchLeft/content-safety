import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArachnidPdqClient } from '../src/arachnid-client.js';
import type { AuditRecord, AuditSink, BatchCheck, PdqHash, Verdict } from '../src/contract.js';
import { isPdqHash } from '../src/pdq-hash.js';
import { PdqKnownMaterialCheck } from '../src/pdq-known-material-check.js';
import { EstatePolicy } from '../src/policy.js';
import { SafetyService } from '../src/safety-service.js';
import { InMemoryVerdictCache } from '../src/verdict-cache.js';
import { DEMO, hashOf, TENANT } from './helpers/fixtures.js';
import { startStubArachnid, type StubArachnid } from './helpers/stub-arachnid.js';

const DAY = 24 * 60 * 60 * 1000;

class MemoryAudit implements AuditSink {
  readonly records: AuditRecord[] = [];
  record(entry: AuditRecord): Promise<void> {
    this.records.push(entry);
    return Promise.resolve();
  }
}

describe('SafetyService end to end against the local stub', () => {
  let stub: StubArachnid;
  let audit: MemoryAudit;
  let service: SafetyService;

  beforeEach(async () => {
    stub = await startStubArachnid(
      new Map([
        [hashOf(1), { classification: 'csam', match_type: 'exact' }],
        [hashOf(2), { classification: 'csam', match_type: 'near' }],
        [hashOf(3), { classification: 'harmful-abusive-material', match_type: 'exact' }],
        [hashOf(4), { classification: 'test', match_type: 'exact' }],
      ])
    );
    audit = new MemoryAudit();
    service = new SafetyService({
      check: new PdqKnownMaterialCheck({
        lookup: new ArachnidPdqClient({ baseUrl: stub.baseUrl, authorization: () => 'PLACEHOLDER_NOT_A_CREDENTIAL' }),
        cache: new InMemoryVerdictCache({ negativeTtlMs: DAY }),
        timeoutMs: 200,
      }),
      policy: new EstatePolicy(),
      audit,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
  });

  afterEach(async () => {
    await stub.close();
  });

  it('turns a batch of hashes into one decision each, by estate', async () => {
    const asked = [1, 2, 3, 4, 5].map(hashOf);
    const demo = await service.assess(asked, DEMO);
    const tenant = await service.assess(asked, TENANT);
    const summary = (xs: typeof demo): string[] =>
      xs.map((a) => (a.decision.action === 'refuse' ? `${a.decision.tier}:${a.decision.steps.at(-1) ?? ''}` : a.decision.action));
    expect(summary(demo)).toEqual(['two:kill-slot-quietly', 'one:freeze', 'one:freeze', 'two:kill-slot-quietly', 'allow']);
    expect(summary(tenant)).toEqual(['two:keep-site-serving', 'one:freeze', 'one:freeze', 'two:keep-site-serving', 'allow']);
    expect(stub.requests).toHaveLength(1);
  });

  it('sends nothing but hashes it was given, in every request body', async () => {
    const asked = [1, 2, 3, 4, 5, 6, 7].map(hashOf);
    await service.assess(asked.slice(0, 3), DEMO);
    await service.assess(asked, TENANT);
    stub.mode = 'never-answer';
    await service.assess([hashOf(8)], TENANT);
    expect(stub.requests.length).toBeGreaterThanOrEqual(3);
    for (const request of stub.requests) {
      const body = JSON.parse(request.body) as Record<string, unknown>;
      expect(Object.keys(body)).toEqual(['hashes']);
      expect(Array.isArray(body.hashes)).toBe(true);
      for (const h of body.hashes as unknown[]) {
        expect(isPdqHash(h)).toBe(true);
        expect([...asked, hashOf(8)]).toContain(h);
      }
      expect(request.body).toBe(JSON.stringify({ hashes: body.hashes }));
    }
  });

  it('audits every decision with digests only', async () => {
    await service.assess([hashOf(1), hashOf(5)], TENANT);
    expect(audit.records).toHaveLength(2);
    for (const record of audit.records) {
      expect(isPdqHash(record.hash)).toBe(true);
      expect(Object.keys(record).sort()).toEqual(['at', 'classification', 'decision', 'estate', 'hash', 'matchType', 'source']);
    }
  });

  it('holds every hash when the stub never answers', async () => {
    stub.mode = 'never-answer';
    const result = await service.assess([hashOf(1), hashOf(5)], DEMO);
    expect(result.map((a) => a.decision)).toEqual([
      { action: 'hold', reason: 'unavailable' },
      { action: 'hold', reason: 'unavailable' },
    ]);
  });
});

describe('SafetyService failure paths', () => {
  const fixedCheck = (verdicts: (hashes: readonly PdqHash[]) => readonly Verdict[]): BatchCheck<PdqHash> => ({
    kind: 'media',
    blocking: true,
    run: (h) => Promise.resolve(verdicts([h])[0] as Verdict),
    runBatch: (hs) => Promise.resolve(verdicts(hs)),
  });
  const failingAudit: AuditSink = { record: () => Promise.reject(new Error('disk full')) };

  it('holds an allow it could not audit, and lets a refusal stand', async () => {
    const service = new SafetyService({
      check: fixedCheck((hs) =>
        hs.map((h) =>
          h === hashOf(1)
            ? { classification: 'csam', matchType: 'exact', source: 's', evidence: h }
            : { classification: 'no-known-match', source: 's', evidence: h }
        )
      ),
      policy: new EstatePolicy(),
      audit: failingAudit,
    });
    const [refused, allowed] = await service.assess([hashOf(1), hashOf(2)], TENANT);
    expect(refused?.decision.action).toBe('refuse');
    expect(allowed?.decision).toEqual({ action: 'hold', reason: 'audit-unavailable' });
  });

  it('holds a hash the check returned no verdict for', async () => {
    const service = new SafetyService({ check: fixedCheck(() => []), policy: new EstatePolicy(), audit: new MemoryAudit() });
    const [only] = await service.assess([hashOf(1)], TENANT);
    expect(only?.decision).toEqual({ action: 'hold', reason: 'unavailable' });
  });

  it('refuses to run an advisory or text check on the hash route', () => {
    const advisory = { ...fixedCheck(() => []), blocking: false };
    const text = { ...fixedCheck(() => []), kind: 'text' as const };
    for (const check of [advisory, text]) {
      expect(() => new SafetyService({ check, policy: new EstatePolicy(), audit: new MemoryAudit() })).toThrow(TypeError);
    }
  });

  it('stamps records with the current time by default', async () => {
    const audit = new MemoryAudit();
    const service = new SafetyService({
      check: fixedCheck((hs) => hs.map((h) => ({ classification: 'no-known-match', source: 's', evidence: h }))),
      policy: new EstatePolicy(),
      audit,
    });
    await service.assess([hashOf(1)], DEMO);
    expect(Number.isNaN(Date.parse(audit.records[0]?.at ?? ''))).toBe(false);
  });
});
