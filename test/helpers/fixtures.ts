import type { PolicyContext } from '../../src/contract.js';
import { parsePdqHash } from '../../src/pdq-hash.js';
import type { PdqHash } from '../../src/contract.js';

/** A synthetic, meaningless hash: 32 copies of one byte. */
export function hashOf(n: number): PdqHash {
  const hash = parsePdqHash(Buffer.alloc(32, n).toString('base64'));
  if (hash === undefined) throw new Error('fixture is not a PDQ hash');
  return hash;
}

export const DEMO: PolicyContext = { kind: 'demo', safety: { near: true, exact: true } };
export const TENANT: PolicyContext = { kind: 'tenant', safety: { near: true, exact: true } };
