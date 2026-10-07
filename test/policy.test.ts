import { describe, expect, it } from 'vitest';
import type { Decision, MatchType, PolicyContext, Verdict } from '../src/contract.js';
import { EstatePolicy } from '../src/policy.js';
import { DEMO, hashOf, TENANT } from './helpers/fixtures.js';

const policy = new EstatePolicy();

function verdict(classification: Verdict['classification'], matchType?: MatchType): Verdict {
  const base: Verdict = { classification, source: 'test', evidence: hashOf(1) };
  return matchType === undefined ? base : { ...base, matchType };
}

const TIER_ONE = (control: boolean): Decision => ({
  action: 'refuse',
  tier: 'one',
  irreversible: false,
  control,
  steps: ['withhold', 'freeze'],
});

const TIER_TWO = (estateStep: 'kill-slot-quietly' | 'keep-site-serving', control: boolean): Decision => ({
  action: 'refuse',
  tier: 'two',
  irreversible: true,
  control,
  steps: ['withhold', 'seal', 'start-reporting-clock', 'page', estateStep],
});

// The response table, one row per classification and match type, for both estates.
const TABLE: ReadonlyArray<{
  readonly row: string;
  readonly v: Verdict;
  readonly demo: Decision;
  readonly tenant: Decision;
}> = [
  {
    row: 'exact + csam is tier two, and only tier two differs by estate',
    v: verdict('csam', 'exact'),
    demo: TIER_TWO('kill-slot-quietly', false),
    tenant: TIER_TWO('keep-site-serving', false),
  },
  { row: 'near + csam is tier one', v: verdict('csam', 'near'), demo: TIER_ONE(false), tenant: TIER_ONE(false) },
  {
    row: 'csam with no match type stays reversible',
    v: verdict('csam'),
    demo: TIER_ONE(false),
    tenant: TIER_ONE(false),
  },
  {
    row: 'exact harmful-abusive-material is tier one',
    v: verdict('harmful-abusive-material', 'exact'),
    demo: TIER_ONE(false),
    tenant: TIER_ONE(false),
  },
  {
    row: 'near harmful-abusive-material is tier one',
    v: verdict('harmful-abusive-material', 'near'),
    demo: TIER_ONE(false),
    tenant: TIER_ONE(false),
  },
  {
    row: 'exact test behaves as an exact match, marked as a control',
    v: verdict('test', 'exact'),
    demo: TIER_TWO('kill-slot-quietly', true),
    tenant: TIER_TWO('keep-site-serving', true),
  },
  {
    row: 'near test behaves as a near match, marked as a control',
    v: verdict('test', 'near'),
    demo: TIER_ONE(true),
    tenant: TIER_ONE(true),
  },
  { row: 'test with no match type is tier one', v: verdict('test'), demo: TIER_ONE(true), tenant: TIER_ONE(true) },
  { row: 'no-known-match is allowed', v: verdict('no-known-match'), demo: { action: 'allow' }, tenant: { action: 'allow' } },
  {
    row: 'unavailable is held, never allowed',
    v: verdict('unavailable'),
    demo: { action: 'hold', reason: 'unavailable' },
    tenant: { action: 'hold', reason: 'unavailable' },
  },
];

describe('EstatePolicy: the response table', () => {
  for (const { row, v, demo, tenant } of TABLE) {
    it(`${row} (demo)`, () => {
      expect(policy.decide(v, DEMO)).toEqual(demo);
    });
    it(`${row} (tenant)`, () => {
      expect(policy.decide(v, TENANT)).toEqual(tenant);
    });
  }

  it('makes only exact + csam (or its test stand-in) irreversible', () => {
    const irreversible = TABLE.filter(({ v }) => {
      const d = policy.decide(v, TENANT);
      return d.action === 'refuse' && d.irreversible;
    }).map(({ v }) => `${v.classification}/${v.matchType ?? '-'}`);
    expect(irreversible).toEqual(['csam/exact', 'test/exact']);
  });

  it('makes a tier-one decision identical on both estates', () => {
    for (const { v } of TABLE) {
      const d = policy.decide(v, DEMO);
      if (d.action === 'refuse' && d.tier === 'one') expect(policy.decide(v, TENANT)).toEqual(d);
    }
  });

  it('holds a classification it does not know rather than allowing it', () => {
    const unknown = { classification: 'something-new', source: 'test', evidence: hashOf(1) } as unknown as Verdict;
    expect(policy.decide(unknown, TENANT)).toEqual({ action: 'hold', reason: 'unavailable' });
  });
});

describe('EstatePolicy: the descriptor context', () => {
  const rejected: ReadonlyArray<readonly [string, PolicyContext]> = [
    ['near axis off', { kind: 'tenant', safety: { near: false, exact: true } }],
    ['exact axis off', { kind: 'demo', safety: { near: true, exact: false } }],
    ['no safety axis', { kind: 'tenant' } as unknown as PolicyContext],
    ['an unknown estate', { kind: 'staging', safety: { near: true, exact: true } } as unknown as PolicyContext],
  ];
  for (const [name, context] of rejected) {
    it(`holds, never allows, with ${name}`, () => {
      expect(policy.decide(verdict('no-known-match'), context)).toEqual({ action: 'hold', reason: 'context-rejected' });
      expect(policy.decide(verdict('csam', 'exact'), context)).toEqual({ action: 'hold', reason: 'context-rejected' });
    });
  }
});
