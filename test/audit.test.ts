import { describe, expect, it } from 'vitest';
import { JsonLinesAuditSink, toAuditRecord } from '../src/audit.js';
import type { Decision, PdqHash, Verdict } from '../src/contract.js';
import { DEMO, hashOf, TENANT } from './helpers/fixtures.js';

const AT = new Date('2026-01-01T00:00:00.000Z');
const RECORD_KEYS = ['at', 'classification', 'decision', 'estate', 'hash', 'matchType', 'source'];

describe('toAuditRecord', () => {
  it('records the digest, the verdict and the decision', () => {
    const verdict: Verdict = { classification: 'csam', matchType: 'near', source: 's', evidence: hashOf(1) };
    const decision: Decision = { action: 'refuse', tier: 'one', irreversible: false, control: false, steps: ['withhold', 'freeze'] };
    expect(toAuditRecord(AT, verdict, decision, TENANT)).toEqual({
      at: '2026-01-01T00:00:00.000Z',
      estate: 'tenant',
      hash: hashOf(1),
      classification: 'csam',
      matchType: 'near',
      source: 's',
      decision,
    });
  });

  it('never carries anything a verdict or decision smuggles in beside its fields', () => {
    const bytes = Buffer.alloc(4096, 0xff).toString('base64');
    const verdict = {
      classification: 'no-known-match',
      source: 's',
      evidence: hashOf(2),
      bytes,
      thumbnail: bytes,
    } as unknown as Verdict;
    const decision = { action: 'hold', reason: 'unavailable', thumbnail: bytes } as unknown as Decision;
    const record = toAuditRecord(AT, verdict, decision, DEMO);
    expect(Object.keys(record).sort()).toEqual(RECORD_KEYS);
    expect(Object.keys(record.decision).sort()).toEqual(['action', 'reason']);
    expect(JSON.stringify(record)).not.toContain(bytes);
  });

  it('copies a refusal decision field by field', () => {
    const decision = {
      action: 'refuse',
      tier: 'two',
      irreversible: true,
      control: false,
      steps: ['withhold'],
      image: 'x',
    } as unknown as Decision;
    const record = toAuditRecord(AT, { classification: 'csam', matchType: 'exact', source: 's', evidence: hashOf(1) }, decision, DEMO);
    expect(Object.keys(record.decision).sort()).toEqual(['action', 'control', 'irreversible', 'steps', 'tier']);
  });

  it('records allow, and a missing match type as null', () => {
    const record = toAuditRecord(AT, { classification: 'no-known-match', source: 's', evidence: hashOf(3) }, { action: 'allow' }, DEMO);
    expect(record.matchType).toBeNull();
    expect(record.decision).toEqual({ action: 'allow' });
  });

  it('refuses evidence that is not a PDQ hash', () => {
    const verdict = {
      classification: 'csam',
      source: 's',
      evidence: Buffer.alloc(4096, 1).toString('base64') as PdqHash,
    } satisfies Verdict;
    expect(() => toAuditRecord(AT, verdict, { action: 'allow' }, DEMO)).toThrow(TypeError);
  });
});

describe('JsonLinesAuditSink', () => {
  it('writes one JSON line per record', async () => {
    const lines: string[] = [];
    const sink = new JsonLinesAuditSink((line) => {
      lines.push(line);
    });
    const record = toAuditRecord(AT, { classification: 'no-known-match', source: 's', evidence: hashOf(1) }, { action: 'allow' }, DEMO);
    await sink.record(record);
    await sink.record(record);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.endsWith('\n')).toBe(true);
    expect(JSON.parse(lines[0] ?? '')).toEqual(record);
  });
});
