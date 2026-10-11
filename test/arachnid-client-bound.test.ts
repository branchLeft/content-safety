import { describe, expect, it, vi } from 'vitest';
import { ArachnidPdqClient, MAX_RESPONSE_BYTES } from '../src/arachnid-client.js';
import { hashOf } from './helpers/fixtures.js';
import { endlessBody } from './helpers/streams.js';

describe('ArachnidPdqClient and an answer that never ends', () => {
  it('stops reading it soon after the bound, cancels it, and fails the lookup', async () => {
    const { response, stats } = endlessBody(64 * 1024);
    const client = new ArachnidPdqClient({
      baseUrl: 'http://127.0.0.1:1',
      authorization: () => 'TEST_SENTINEL',
      fetch: async () => response,
    });

    await expect(client.lookup([hashOf(1)], new AbortController().signal)).rejects.toThrow();

    expect(stats.pulled).toBeLessThanOrEqual(MAX_RESPONSE_BYTES + 256 * 1024);
    await vi.waitFor(() => expect(stats.cancelled).toBe(true));
  });
});
