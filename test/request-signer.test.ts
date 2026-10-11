import { verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Secret, SecretFileError } from '../src/credential.js';
import {
  NONCE_HEADER,
  RequestSigner,
  SIGNATURE_HEADER,
  signingPayload,
  TIMESTAMP_HEADER,
} from '../src/request-signer.js';
import { makeSigningKey } from './helpers/keys.js';

const NOW = new Date('2026-01-02T03:04:05.678Z');

describe('RequestSigner', () => {
  it('signs method, path, timestamp, nonce and body so only the named public key verifies it', () => {
    const key = makeSigningKey();
    const signer = new RequestSigner(new Secret(key.seedBase64), { now: () => NOW, nonce: () => 'nonce-0123456789ab' });

    const headers = signer.sign('POST', '/safety/v1/verdicts', '{"v":1}');

    expect(headers[TIMESTAMP_HEADER]).toBe(String(Math.floor(NOW.getTime() / 1000)));
    expect(headers[NONCE_HEADER]).toBe('nonce-0123456789ab');
    const signature = Buffer.from(headers[SIGNATURE_HEADER], 'base64');
    const covered = (method: string, path: string, body: string): Buffer =>
      signingPayload(method, path, headers[TIMESTAMP_HEADER], headers[NONCE_HEADER], Buffer.from(body));
    expect(verify(null, covered('POST', '/safety/v1/verdicts', '{"v":1}'), key.publicKey, signature)).toBe(true);
    expect(verify(null, covered('GET', '/safety/v1/verdicts', '{"v":1}'), key.publicKey, signature)).toBe(false);
    expect(verify(null, covered('POST', '/safety/v1/pending', '{"v":1}'), key.publicKey, signature)).toBe(false);
    expect(verify(null, covered('POST', '/safety/v1/verdicts', '{"v":2}'), key.publicKey, signature)).toBe(false);
    expect(verify(null, covered('POST', '/safety/v1/verdicts', '{"v":1}'), makeSigningKey().publicKey, signature)).toBe(
      false
    );
  });

  it('draws a fresh 32-character nonce for every request by default', () => {
    const signer = new RequestSigner(new Secret(makeSigningKey().seedBase64));

    const first = signer.sign('GET', '/safety/v1/pending', '')[NONCE_HEADER];
    const second = signer.sign('GET', '/safety/v1/pending', '')[NONCE_HEADER];

    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(second).not.toBe(first);
  });

  it('refuses a key that is not the base64 of exactly 32 bytes', () => {
    for (const bad of ['', 'not base64!', Buffer.alloc(31).toString('base64'), Buffer.alloc(33).toString('base64')]) {
      expect(() => new RequestSigner(new Secret(bad))).toThrow(SecretFileError);
    }
  });

  it('never puts the key in the refusal', () => {
    try {
      new RequestSigner(new Secret('TEST_SENTINEL_KEY_VALUE'));
    } catch (error) {
      expect((error as Error).message).not.toContain('TEST_SENTINEL_KEY_VALUE');
      return;
    }
    throw new Error('expected a refusal');
  });
});
