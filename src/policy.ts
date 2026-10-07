import type { Decision, Policy, PolicyContext, ResponseStep, Verdict } from './contract.js';

const TIER_ONE_STEPS: readonly ResponseStep[] = ['withhold', 'freeze'];
const TIER_TWO_COMMON: readonly ResponseStep[] = ['withhold', 'seal', 'start-reporting-clock', 'page'];

/**
 * The one place the demo-versus-tenant divergence lives. Two tiers: only an
 * exact csam match is irreversible, because a perceptual false positive must
 * never be terminal on its own. Tier one is identical on both estates.
 */
export class EstatePolicy implements Policy {
  decide(verdict: Verdict, context: PolicyContext): Decision {
    if (!isAcceptedContext(context)) return { action: 'hold', reason: 'context-rejected' };
    switch (verdict.classification) {
      case 'no-known-match':
        return { action: 'allow' };
      case 'unavailable':
        return { action: 'hold', reason: 'unavailable' };
      case 'csam':
      case 'test':
        // `test` behaves as a match through the whole path, so it lands in
        // whichever tier its match type selects and is only marked as a control.
        return verdict.matchType === 'exact'
          ? tierTwo(context, verdict.classification === 'test')
          : tierOne(verdict.classification === 'test');
      case 'harmful-abusive-material':
        return tierOne(false);
      default:
        return { action: 'hold', reason: 'unavailable' };
    }
  }
}

function tierOne(control: boolean): Decision {
  return { action: 'refuse', tier: 'one', irreversible: false, control, steps: TIER_ONE_STEPS };
}

function tierTwo(context: PolicyContext, control: boolean): Decision {
  const estateStep: ResponseStep = context.kind === 'demo' ? 'kill-slot-quietly' : 'keep-site-serving';
  return { action: 'refuse', tier: 'two', irreversible: true, control, steps: [...TIER_TWO_COMMON, estateStep] };
}

/**
 * The descriptor's own validation requires both axes on for every host.
 * A context that says otherwise is not one this policy can act on, and an
 * axis turned off must never quietly weaken a match into an allow.
 */
function isAcceptedContext(context: PolicyContext): boolean {
  const kindOk = context.kind === 'demo' || context.kind === 'tenant';
  const safety: unknown = context.safety;
  if (typeof safety !== 'object' || safety === null) return false;
  const axis = safety as { near?: unknown; exact?: unknown };
  return kindOk && axis.near === true && axis.exact === true;
}
