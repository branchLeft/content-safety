import { describe, expect, it } from 'vitest';
import { buildVerdictsBody } from '../src/channel-contract.js';
import type { VerdictEntry } from '../src/channel-contract.js';
import type { Assessment, Decision, PdqHash, ResponseStep, Verdict } from '../src/contract.js';
import { admits, answersFor, mayPass, parseVerdictsBody } from '../src/verdict-schema.js';
import { hashOf } from './helpers/fixtures.js';

const BATCH = 'batch-0123456789abcdef';

type Mutable = Record<string, unknown>;

function entry(overrides: Mutable = {}): Mutable {
  return {
    hash: hashOf(1),
    classification: 'no-known-match',
    source: 'arachnid-shield-pdq',
    decision: { action: 'allow' },
    audited: true,
    ...overrides,
  };
}

function body(overrides: Mutable = {}): Mutable {
  return { v: 1, batch: BATCH, verdicts: [entry()], ...overrides };
}

function without(source: Mutable, key: string): Mutable {
  const copy = { ...source };
  delete copy[key];
  return copy;
}

const refusal = { action: 'refuse', tier: 'two', irreversible: true, control: false, steps: ['withhold', 'seal'] };

describe('a verdicts body, field by field', () => {
  it('reads a well-formed body', () => {
    expect(parseVerdictsBody(body())).toEqual({
      v: 1,
      batch: BATCH,
      verdicts: [{ hash: hashOf(1), classification: 'no-known-match', source: 'arachnid-shield-pdq', decision: { action: 'allow' }, audited: true }],
    });
  });

  it('refuses anything that is not an object', () => {
    for (const bad of [null, undefined, 'x', 7, [], [body()]]) expect(parseVerdictsBody(bad)).toBeUndefined();
  });

  it('v: must be the number 1', () => {
    expect(parseVerdictsBody(without(body(), 'v'))).toBeUndefined();
    for (const bad of [2, 0, '1', null, true]) expect(parseVerdictsBody(body({ v: bad }))).toBeUndefined();
  });

  it('batch: must be present and a batch name', () => {
    expect(parseVerdictsBody(without(body(), 'batch'))).toBeUndefined();
    for (const bad of ['short', 'has space 0123456789', 'x'.repeat(129), 7, null]) {
      expect(parseVerdictsBody(body({ batch: bad }))).toBeUndefined();
    }
  });

  it('verdicts: must be an array, which may be empty', () => {
    expect(parseVerdictsBody(without(body(), 'verdicts'))).toBeUndefined();
    for (const bad of ['x', {}, null, 7]) expect(parseVerdictsBody(body({ verdicts: bad }))).toBeUndefined();
    expect(parseVerdictsBody(body({ verdicts: [] }))?.verdicts).toEqual([]);
  });

  it('the body: a field the version does not name makes it unreadable', () => {
    expect(parseVerdictsBody(body({ extra: 1 }))).toBeUndefined();
  });

  it('hash: must be present and the canonical base64 of 32 bytes', () => {
    expect(parseVerdictsBody(body({ verdicts: [without(entry(), 'hash')] }))).toBeUndefined();
    for (const bad of ['https://example.invalid/a.png', 'AAAA', 7, null, Buffer.alloc(31).toString('base64')]) {
      expect(parseVerdictsBody(body({ verdicts: [entry({ hash: bad })] }))).toBeUndefined();
    }
  });

  it('classification: must be present and one of the five values', () => {
    expect(parseVerdictsBody(body({ verdicts: [without(entry(), 'classification')] }))).toBeUndefined();
    for (const bad of ['allow', 'clean', '', 7, null, 'toString']) {
      expect(parseVerdictsBody(body({ verdicts: [entry({ classification: bad })] }))).toBeUndefined();
    }
    for (const good of ['csam', 'harmful-abusive-material', 'test', 'no-known-match', 'unavailable']) {
      expect(parseVerdictsBody(body({ verdicts: [entry({ classification: good })] }))).toBeDefined();
    }
  });

  it('matchType: may be left out, and otherwise is exact or near', () => {
    expect(parseVerdictsBody(body())?.verdicts[0]).not.toHaveProperty('matchType');
    for (const good of ['exact', 'near']) {
      expect(parseVerdictsBody(body({ verdicts: [entry({ matchType: good })] }))?.verdicts[0]?.matchType).toBe(good);
    }
    for (const bad of ['partial', '', 1, null]) {
      expect(parseVerdictsBody(body({ verdicts: [entry({ matchType: bad })] }))).toBeUndefined();
    }
  });

  it('source: must be present and a non-empty string', () => {
    expect(parseVerdictsBody(body({ verdicts: [without(entry(), 'source')] }))).toBeUndefined();
    for (const bad of ['', 7, null, {}]) {
      expect(parseVerdictsBody(body({ verdicts: [entry({ source: bad })] }))).toBeUndefined();
    }
  });

  it('audited: must be present and a boolean', () => {
    expect(parseVerdictsBody(body({ verdicts: [without(entry(), 'audited')] }))).toBeUndefined();
    for (const bad of ['true', 1, 0, null]) {
      expect(parseVerdictsBody(body({ verdicts: [entry({ audited: bad })] }))).toBeUndefined();
    }
    expect(parseVerdictsBody(body({ verdicts: [entry({ audited: false })] }))?.verdicts[0]?.audited).toBe(false);
  });

  it('an entry: a field the version does not name makes the body unreadable', () => {
    expect(parseVerdictsBody(body({ verdicts: [entry({ thumbnail: 'AAAA' })] }))).toBeUndefined();
  });

  it('an entry: one that does not read makes the whole body unreadable', () => {
    expect(parseVerdictsBody(body({ verdicts: [entry(), entry({ hash: 'nope' })] }))).toBeUndefined();
    expect(parseVerdictsBody(body({ verdicts: [entry(), null] }))).toBeUndefined();
  });
});

describe('a decision, field by field', () => {
  const read = (decision: unknown) => parseVerdictsBody(body({ verdicts: [entry({ decision })] }))?.verdicts[0]?.decision;

  it('decision: must be present and an object', () => {
    expect(parseVerdictsBody(body({ verdicts: [without(entry(), 'decision')] }))).toBeUndefined();
    for (const bad of ['allow', null, [], 7]) expect(read(bad)).toBeUndefined();
  });

  it('action: must be allow, hold or refuse', () => {
    for (const bad of [undefined, 'permit', 'none', '', 7]) expect(read({ action: bad })).toBeUndefined();
    expect(read({ action: 'allow' })).toEqual({ action: 'allow' });
  });

  it('allow: carries nothing else', () => {
    expect(read({ action: 'allow', reason: 'unavailable' })).toBeUndefined();
  });

  it('hold.reason: must be present and one of the three reasons', () => {
    expect(read({ action: 'hold' })).toBeUndefined();
    for (const bad of ['other', '', 7, null]) expect(read({ action: 'hold', reason: bad })).toBeUndefined();
    for (const good of ['unavailable', 'context-rejected', 'audit-unavailable']) {
      expect(read({ action: 'hold', reason: good })).toEqual({ action: 'hold', reason: good });
    }
  });

  it('hold: carries nothing else', () => {
    expect(read({ action: 'hold', reason: 'unavailable', tier: 'one' })).toBeUndefined();
  });

  it('refuse.tier: must be present and one or two', () => {
    expect(read(without(refusal, 'tier'))).toBeUndefined();
    for (const bad of ['three', 1, null]) expect(read({ ...refusal, tier: bad })).toBeUndefined();
    expect(read({ ...refusal, tier: 'one' })).toMatchObject({ tier: 'one' });
  });

  it('refuse.irreversible: must be present and a boolean', () => {
    expect(read(without(refusal, 'irreversible'))).toBeUndefined();
    for (const bad of ['true', 1, null]) expect(read({ ...refusal, irreversible: bad })).toBeUndefined();
  });

  it('refuse.control: must be present and a boolean', () => {
    expect(read(without(refusal, 'control'))).toBeUndefined();
    for (const bad of ['false', 0, null]) expect(read({ ...refusal, control: bad })).toBeUndefined();
  });

  it('refuse.steps: must be present, an array, and only the named steps', () => {
    expect(read(without(refusal, 'steps'))).toBeUndefined();
    for (const bad of ['withhold', {}, null, ['withhold', 'delete-everything'], [7]]) {
      expect(read({ ...refusal, steps: bad })).toBeUndefined();
    }
    const all: readonly ResponseStep[] = [
      'withhold',
      'freeze',
      'seal',
      'start-reporting-clock',
      'page',
      'kill-slot-quietly',
      'keep-site-serving',
    ];
    expect(read({ ...refusal, steps: all })).toMatchObject({ steps: all });
  });

  it('refuse: carries nothing else', () => {
    expect(read({ ...refusal, leaked: 'x' })).toBeUndefined();
  });
});

describe('what the writer emits is what the reader reads', () => {
  const decisions: readonly Decision[] = [
    { action: 'allow' },
    { action: 'hold', reason: 'unavailable' },
    { action: 'hold', reason: 'context-rejected' },
    { action: 'hold', reason: 'audit-unavailable' },
    { action: 'refuse', tier: 'one', irreversible: false, control: true, steps: ['withhold', 'freeze'] },
    { action: 'refuse', tier: 'two', irreversible: true, control: false, steps: ['withhold', 'seal', 'start-reporting-clock', 'page', 'kill-slot-quietly'] },
  ];

  it('round-trips every decision shape and both match types', () => {
    const assessments = decisions.map((decision, i): Assessment => {
      const verdict: Verdict = {
        classification: decision.action === 'refuse' ? 'csam' : 'no-known-match',
        ...(i % 2 === 0 ? { matchType: 'near' as const } : {}),
        source: 'arachnid-shield-pdq',
        evidence: hashOf(i + 1),
      };
      return { hash: hashOf(i + 1), verdict, decision, audited: i !== 3 };
    });

    const read = parseVerdictsBody(JSON.parse(buildVerdictsBody(BATCH, assessments)));

    expect(read?.verdicts.map((e) => e.decision)).toEqual(decisions);
    expect(read?.verdicts.map((e) => e.audited)).toEqual(assessments.map((a) => a.audited));
    expect(read?.verdicts.map((e) => e.matchType)).toEqual(assessments.map((a) => a.verdict.matchType));
  });
});

describe('whether a verdict lets an upload through', () => {
  const read = (overrides: Mutable): VerdictEntry => {
    const parsed = parseVerdictsBody(body({ verdicts: [entry(overrides)] }));
    if (parsed?.verdicts[0] === undefined) throw new Error('fixture does not read');
    return parsed.verdicts[0];
  };

  it('admits a no-known-match that the service allowed', () => {
    expect(admits(read({}))).toBe(true);
  });

  it('does not admit any other classification, even one marked allow', () => {
    for (const classification of ['csam', 'harmful-abusive-material', 'test', 'unavailable']) {
      expect(admits(read({ classification, decision: { action: 'allow' } }))).toBe(false);
    }
  });

  it('does not admit a no-known-match that the service held or refused', () => {
    expect(admits(read({ decision: { action: 'hold', reason: 'audit-unavailable' } }))).toBe(false);
    expect(admits(read({ decision: refusal }))).toBe(false);
  });
});

describe('the answer to what was asked', () => {
  const offered = [hashOf(1), hashOf(2)] as readonly PdqHash[];
  const answered = (verdicts: readonly Mutable[], batch = BATCH) => {
    const parsed = parseVerdictsBody(body({ verdicts }));
    if (parsed === undefined) throw new Error('fixture does not read');
    return answersFor(parsed, batch, offered);
  };

  it('keys each answer by the hash that was offered', () => {
    const answers = answered([entry({ hash: hashOf(1) }), entry({ hash: hashOf(2), classification: 'csam', decision: refusal })]);

    expect(mayPass(answers, hashOf(1))).toBe(true);
    expect(mayPass(answers, hashOf(2))).toBe(false);
  });

  it('gives no pass to a hash with no verdict', () => {
    expect(mayPass(answered([entry({ hash: hashOf(1) })]), hashOf(2))).toBe(false);
  });

  it('ignores a verdict for a hash that was never offered', () => {
    const answers = answered([entry({ hash: hashOf(1) }), entry({ hash: hashOf(9) })]);

    expect(answers.has(hashOf(9))).toBe(false);
    expect(mayPass(answers, hashOf(9))).toBe(false);
  });

  it('gives no pass on an answer filed under another batch', () => {
    const answers = answered([entry({ hash: hashOf(1) })], 'another-batch-0123456789');

    expect(mayPass(answers, hashOf(1))).toBe(false);
  });

  it('settles neither answer when one hash is answered twice', () => {
    const answers = answered([entry({ hash: hashOf(1) }), entry({ hash: hashOf(1), classification: 'csam', decision: refusal }), entry({ hash: hashOf(1) })]);

    expect(answers.has(hashOf(1))).toBe(false);
    expect(mayPass(answers, hashOf(1))).toBe(false);
  });
});
