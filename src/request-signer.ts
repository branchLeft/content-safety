import { createPrivateKey, randomBytes, sign, type KeyObject } from 'node:crypto';
import type { Secret } from './credential.js';
import { SecretFileError } from './credential.js';

export const TIMESTAMP_HEADER = 'x-broker-timestamp';
export const NONCE_HEADER = 'x-broker-nonce';
export const SIGNATURE_HEADER = 'x-broker-signature';

const ED25519_SEED_BYTES = 32;
// The fixed PKCS8 prefix of an unencrypted Ed25519 private key; only the
// 32 seed bytes after it vary.
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export interface SignedHeaders {
  readonly [TIMESTAMP_HEADER]: string;
  readonly [NONCE_HEADER]: string;
  readonly [SIGNATURE_HEADER]: string;
}

/**
 * Method, path, timestamp and nonce are covered as well as the body, so a
 * signed poll cannot be replayed as a verdict submission.
 */
export function signingPayload(
  method: string,
  path: string,
  timestampSeconds: string,
  nonce: string,
  body: Buffer
): Buffer {
  return Buffer.concat([Buffer.from(`${method}\n${path}\n${timestampSeconds}\n${nonce}\n`, 'utf8'), body]);
}

export interface RequestSignerOptions {
  readonly now?: () => Date;
  readonly nonce?: () => string;
}

/**
 * Lets a host tell this service from anyone else who can reach it. The host
 * holds only the matching public key, which is not a credential.
 */
export class RequestSigner {
  readonly #key: KeyObject;
  readonly #now: () => Date;
  readonly #nonce: () => string;

  /** `seed` is the base64 of the 32-byte Ed25519 private seed. */
  constructor(seed: Secret, options: RequestSignerOptions = {}) {
    const raw = Buffer.from(seed.reveal(), 'base64');
    if (raw.length !== ED25519_SEED_BYTES || raw.toString('base64') !== seed.reveal()) {
      throw new SecretFileError('signing key: the file must hold the base64 of exactly 32 bytes');
    }
    this.#key = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw]), format: 'der', type: 'pkcs8' });
    this.#now = options.now ?? (() => new Date());
    this.#nonce = options.nonce ?? (() => randomBytes(16).toString('hex'));
  }

  sign(method: string, path: string, body: string): SignedHeaders {
    const timestamp = String(Math.floor(this.#now().getTime() / 1000));
    const nonce = this.#nonce();
    const signature = sign(null, signingPayload(method, path, timestamp, nonce, Buffer.from(body, 'utf8')), this.#key);
    return {
      [TIMESTAMP_HEADER]: timestamp,
      [NONCE_HEADER]: nonce,
      [SIGNATURE_HEADER]: signature.toString('base64'),
    };
  }
}
