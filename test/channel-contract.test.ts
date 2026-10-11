import { describe, expect, it } from 'vitest';
import {
  buildVerdictsBody,
  CHANNEL_VERSION,
  MAX_BATCH_HASHES,
  MAX_BODY_BYTES,
  parsePendingBatch,
  type VerdictsBody,
} from '../src/channel-contract.js';
import type { Assessment, Decision, PdqHash } from '../src/contract.js';
import { hashOf } from './helpers/fixtures.js';

const BATCH = 'batch-0123456789abcdef';

function assessment(hash: PdqHash, decision: Decision, extra: Record<string, unknown> = {}): Assessment {
  const verdict = { classification: 'no-known-match', source: 'arachnid-shield-pdq', evidence: hash } as const;
  return { hash, verdict, decision, audited: true, ...extra } as Assessment;
}

describe('parsePendingBatch', () => {
  it('reads the batch name and the hashes', () => {
    const parsed = parsePendingBatch({ v: CHANNEL_VERSION, batch: BATCH, hashes: [hashOf(1), hashOf(2)] });

    expect(parsed).toEqual({ batch: BATCH, hashes: [hashOf(1), hashOf(2)], skipped: 0 });
  });

  it('answers an empty poll without needing a batch name', () => {
    expect(parsePendingBatch({ v: 1, hashes: [] })).toEqual({ batch: '', hashes: [], skipped: 0 });
  });

  it('drops entries that are not PDQ hashes, repeats, and anything past the cap, and counts them', () => {
    const many = Array.from({ length: MAX_BATCH_HASHES + 2 }, (_, i) =>
      Buffer.alloc(32, i % 256)
        .fill(i & 0xff, 0, 1)
        .fill(i >> 8, 1, 2)
        .toString('base64')
    );
    const parsed = parsePendingBatch({
      v: 1,
      batch: BATCH,
      hashes: [hashOf(1), hashOf(1), 'https://example.invalid/a.png', 42, null, ...many],
    });

    expect(parsed?.hashes).toHaveLength(MAX_BATCH_HASHES);
    expect(parsed?.hashes[0]).toBe(hashOf(1));
    expect(parsed?.skipped).toBe(1 + 1 + 1 + 1 + 3);
  });

  it('refuses anything that is not a version-1 batch', () => {
    expect(parsePendingBatch(null)).toBeUndefined();
    expect(parsePendingBatch([])).toBeUndefined();
    expect(parsePendingBatch({ v: 2, batch: BATCH, hashes: [hashOf(1)] })).toBeUndefined();
    expect(parsePendingBatch({ v: 1, batch: BATCH, hashes: 'x' })).toBeUndefined();
    expect(parsePendingBatch({ v: 1, hashes: [hashOf(1)] })).toBeUndefined();
    expect(parsePendingBatch({ v: 1, batch: 'short', hashes: [hashOf(1)] })).toBeUndefined();
  });
});

describe('buildVerdictsBody', () => {
  it('carries the named fields of each assessment and nothing else', () => {
    const body = JSON.parse(
      buildVerdictsBody(BATCH, [
        assessment(hashOf(1), { action: 'allow' }, { thumbnail: 'AAAA', note: 'x' }),
        {
          ...assessment(hashOf(2), { action: 'allow' }),
          verdict: {
            classification: 'csam',
            matchType: 'near',
            confidence: 0.9,
            source: 'arachnid-shield-pdq',
            evidence: hashOf(2),
            extra: 'dropped',
          } as never,
          decision: {
            action: 'refuse',
            tier: 'one',
            irreversible: false,
            control: false,
            steps: ['withhold', 'freeze'],
            leaked: 'dropped',
          } as never,
          audited: false,
        },
      ])
    ) as VerdictsBody;

    expect(body.v).toBe(1);
    expect(body.batch).toBe(BATCH);
    expect(body.verdicts[0]).toEqual({
      hash: hashOf(1),
      classification: 'no-known-match',
      source: 'arachnid-shield-pdq',
      decision: { action: 'allow' },
      audited: true,
    });
    expect(body.verdicts[1]).toEqual({
      hash: hashOf(2),
      classification: 'csam',
      matchType: 'near',
      source: 'arachnid-shield-pdq',
      decision: { action: 'refuse', tier: 'one', irreversible: false, control: false, steps: ['withhold', 'freeze'] },
      audited: false,
    });
  });

  it('refuses to return a verdict about a value that is not a PDQ hash', () => {
    const bad = assessment('not-a-hash' as PdqHash, { action: 'allow' });

    expect(() => buildVerdictsBody(BATCH, [bad])).toThrow(TypeError);
  });

  it('holds a full batch of refusals inside the body limit', () => {
    const refusal: Decision = {
      action: 'refuse',
      tier: 'two',
      irreversible: true,
      control: false,
      steps: ['withhold', 'seal', 'start-reporting-clock', 'page', 'kill-slot-quietly'],
    };
    const all = Array.from({ length: MAX_BATCH_HASHES }, (_, i) =>
      assessment(Buffer.alloc(32, i % 256).toString('base64') as PdqHash, refusal)
    );

    expect(Buffer.byteLength(buildVerdictsBody(BATCH, all))).toBeLessThan(MAX_BODY_BYTES);
  });

  it('refuses a body past the limit', () => {
    const long = assessment(hashOf(1), { action: 'allow' });
    const many = Array.from({ length: 5000 }, () => long);

    expect(() => buildVerdictsBody(BATCH, many)).toThrow(RangeError);
  });
});
