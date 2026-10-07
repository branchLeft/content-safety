import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ArachnidPdqClient,
  buildPdqRequestBody,
  parsePdqResponse,
  PDQ_PATH,
} from '../src/arachnid-client.js';
import type { PdqHash } from '../src/contract.js';
import { hashOf } from './helpers/fixtures.js';
import { startStubArachnid, type StubArachnid } from './helpers/stub-arachnid.js';

const AUTH = 'PLACEHOLDER_NOT_A_CREDENTIAL';

describe('ArachnidPdqClient against the local stub', () => {
  let stub: StubArachnid;
  let client: ArachnidPdqClient;

  beforeEach(async () => {
    stub = await startStubArachnid(
      new Map([
        [hashOf(1), { classification: 'csam', match_type: 'exact' }],
        [hashOf(2), { classification: 'harmful-abusive-material', match_type: 'near' }],
      ])
    );
    client = new ArachnidPdqClient({ baseUrl: stub.baseUrl, authorization: () => AUTH });
  });

  afterEach(async () => {
    await stub.close();
  });

  it('asks the hash endpoint and nothing else, once per batch', async () => {
    await client.lookup([hashOf(1), hashOf(2), hashOf(3)], new AbortController().signal);
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]?.method).toBe('POST');
    expect(stub.requests[0]?.path).toBe(PDQ_PATH);
    expect(PDQ_PATH).toBe('/v1/pdq');
  });

  it('sends a body of hashes and nothing but hashes', async () => {
    const asked = [hashOf(1), hashOf(2), hashOf(3)];
    await client.lookup(asked, new AbortController().signal);
    const sent = JSON.parse(stub.requests[0]?.body ?? 'null') as Record<string, unknown>;
    expect(Object.keys(sent)).toEqual(['hashes']);
    expect(sent.hashes).toEqual(asked);
    expect(stub.requests[0]?.contentType).toBe('application/json');
  });

  it('carries the injected authorization header', async () => {
    await client.lookup([hashOf(1)], new AbortController().signal);
    expect(stub.requests[0]?.authorization).toBe(AUTH);
  });

  it('maps classification and match_type for every hash it was asked about', async () => {
    const result = await client.lookup([hashOf(1), hashOf(2), hashOf(3)], new AbortController().signal);
    expect(result.get(hashOf(1))).toEqual({ classification: 'csam', matchType: 'exact' });
    expect(result.get(hashOf(2))).toEqual({ classification: 'harmful-abusive-material', matchType: 'near' });
    expect(result.get(hashOf(3))).toEqual({ classification: 'no-known-match' });
  });

  it('rejects on a non-2xx answer', async () => {
    stub.mode = 'server-error';
    await expect(client.lookup([hashOf(1)], new AbortController().signal)).rejects.toThrow(/HTTP 503/);
  });

  it('refuses to follow a redirect, so the body is never re-sent elsewhere', async () => {
    stub.mode = 'redirect';
    await expect(client.lookup([hashOf(1)], new AbortController().signal)).rejects.toThrow();
    expect(stub.requests.map((r) => r.path)).toEqual([PDQ_PATH]);
  });

  it('rejects on a body that is not JSON', async () => {
    stub.mode = 'not-json';
    await expect(client.lookup([hashOf(1)], new AbortController().signal)).rejects.toThrow();
  });
});

describe('buildPdqRequestBody', () => {
  it('refuses anything that is not a PDQ hash, even if the type system was bypassed', () => {
    const bytes = Buffer.alloc(4096, 1).toString('base64') as PdqHash;
    expect(() => buildPdqRequestBody([hashOf(1), bytes])).toThrow(TypeError);
  });
});

describe('parsePdqResponse', () => {
  const asked = [hashOf(1), hashOf(2)];

  it('leaves out anything it cannot read, so it has no verdict', () => {
    const cases: unknown[] = [
      null,
      [],
      'text',
      { scanned_hashes: null },
      { scanned_hashes: [] },
      { scanned_hashes: { [hashOf(1)]: 'csam' } },
      { scanned_hashes: { [hashOf(1)]: { classification: 7 } } },
      { scanned_hashes: { [hashOf(1)]: { classification: 'probably-fine' } } },
    ];
    for (const payload of cases) {
      expect(parsePdqResponse(payload, asked).size).toBe(0);
    }
  });

  it('ignores an unknown match type rather than guessing one', () => {
    const result = parsePdqResponse(
      { scanned_hashes: { [hashOf(1)]: { classification: 'csam', match_type: 'fuzzy' } } },
      asked
    );
    expect(result.get(hashOf(1))).toEqual({ classification: 'csam' });
  });

  it('reads only the hashes it asked about', () => {
    const result = parsePdqResponse(
      { scanned_hashes: { [hashOf(9)]: { classification: 'no-known-match' } } },
      asked
    );
    expect(result.size).toBe(0);
  });

  it('does not read inherited properties as answers', () => {
    const scanned = Object.create({ [hashOf(1)]: { classification: 'no-known-match' } }) as object;
    expect(parsePdqResponse({ scanned_hashes: scanned }, asked).size).toBe(0);
  });
});
