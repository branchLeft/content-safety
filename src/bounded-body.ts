export class BodyTooLarge extends Error {
  constructor() {
    super('response body exceeds its limit');
    this.name = 'BodyTooLarge';
  }
}

/**
 * Counts bytes as they arrive and cancels the stream past the limit: buffering
 * first would let one peer exhaust the memory of a process serving every host.
 */
export async function readBoundedText(response: Response, limitBytes: number): Promise<string> {
  const body = response.body;
  if (body === null) return '';
  const declared = Number(response.headers.get('content-length'));
  if (declared > limitBytes) {
    void body.cancel().catch(() => undefined);
    throw new BodyTooLarge();
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limitBytes) {
      void reader.cancel().catch(() => undefined);
      throw new BodyTooLarge();
    }
    chunks.push(value);
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
}

/** Releases the connection of an answer whose body is not wanted, without reading it. */
export function discardBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}
