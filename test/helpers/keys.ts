import { generateKeyPairSync, type KeyObject } from 'node:crypto';

export interface TestSigningKey {
  /** What the signing key file holds: the base64 of the 32-byte seed. */
  readonly seedBase64: string;
  /** What a host would hold: the public half only. */
  readonly publicKey: KeyObject;
}

/** A throwaway key made in memory; nothing here is, or resembles, a real key. */
export function makeSigningKey(): TestSigningKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const der = privateKey.export({ format: 'der', type: 'pkcs8' });
  return { seedBase64: der.subarray(der.length - 32).toString('base64'), publicKey };
}
