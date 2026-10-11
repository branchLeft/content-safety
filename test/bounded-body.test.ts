import { describe, expect, it, vi } from 'vitest';
import { BodyTooLarge, discardBody, readBoundedText } from '../src/bounded-body.js';
import { endlessBody } from './helpers/streams.js';

describe('readBoundedText', () => {
  it('returns a body that is exactly the limit, and an absent body as empty', async () => {
    expect(await readBoundedText(new Response('x'.repeat(100)), 100)).toBe('x'.repeat(100));
    expect(await readBoundedText(new Response(null, { status: 204 }), 100)).toBe('');
  });

  it('counts bytes, not characters: a body over the limit in bytes and under it in characters is refused', async () => {
    const body = '€'.repeat(100);

    expect(body.length).toBe(100);
    expect(Buffer.byteLength(body)).toBe(300);
    await expect(readBoundedText(new Response(body), 200)).rejects.toBeInstanceOf(BodyTooLarge);
  });

  it('decodes a character split across chunk boundaries', async () => {
    const bytes = Buffer.from('a€b', 'utf8');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });

    expect(await readBoundedText(new Response(stream), 100)).toBe('a€b');
  });

  it('stops reading an endless stream soon after the limit and cancels it', async () => {
    const { response, stats } = endlessBody(1024);

    await expect(readBoundedText(response, 10 * 1024)).rejects.toBeInstanceOf(BodyTooLarge);

    expect(stats.pulled).toBeGreaterThan(10 * 1024);
    expect(stats.pulled).toBeLessThanOrEqual(10 * 1024 + 4 * 1024);
    await vi.waitFor(() => expect(stats.cancelled).toBe(true));
  });

  it('refuses a declared length over the limit without reading the body', async () => {
    const { response, stats } = endlessBody(1024, { status: 200, headers: { 'content-length': '999999' } });

    await expect(readBoundedText(response, 1000)).rejects.toBeInstanceOf(BodyTooLarge);

    expect(stats.pulled).toBe(0);
    await vi.waitFor(() => expect(stats.cancelled).toBe(true));
  });
});

describe('discardBody', () => {
  it('cancels a body nobody will read, and accepts one that has none', async () => {
    const { response, stats } = endlessBody(1024);

    discardBody(response);
    discardBody(new Response(null, { status: 204 }));

    await vi.waitFor(() => expect(stats.cancelled).toBe(true));
  });
});
