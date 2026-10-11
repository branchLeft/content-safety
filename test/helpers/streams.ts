export interface StreamStats {
  /** Bytes the consumer has pulled out of the stream so far. */
  pulled: number;
  cancelled: boolean;
}

const DEFAULT_TOTAL_BYTES = 64 * 1024 * 1024;

/**
 * A body that runs far past any bound, recording how much was read. It ends
 * at `totalBytes`, so a reader that buffers fails an assertion, not a hang.
 */
export function endlessBody(
  chunkBytes: number,
  init: ResponseInit = { status: 200 },
  totalBytes = DEFAULT_TOTAL_BYTES
): { response: Response; stats: StreamStats } {
  const stats: StreamStats = { pulled: 0, cancelled: false };
  const chunk = new Uint8Array(chunkBytes).fill(0x20);
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (stats.pulled >= totalBytes) {
          controller.close();
          return;
        }
        stats.pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() {
        stats.cancelled = true;
      },
    },
    { highWaterMark: 0 }
  );
  return { response: new Response(stream, init), stats };
}
