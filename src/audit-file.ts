import { open, type FileHandle } from 'node:fs/promises';

export interface AuditFile {
  /** Appends one line and returns once it is on disk. Writes are serialised. */
  write(line: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * Append-only, never truncated, owner-readable, and each line synced
 * before its write counts as done: it must survive a restart.
 */
export async function openAuditFile(path: string): Promise<AuditFile> {
  const handle: FileHandle = await open(path, 'a', 0o600);
  let tail: Promise<void> = Promise.resolve();
  return {
    write(line: string): Promise<void> {
      const next = tail.then(async () => {
        await handle.appendFile(line, 'utf8');
        await handle.datasync();
      });
      // A failed write must fail its own caller only, not every later write.
      tail = next.catch(() => undefined);
      return next;
    },
    close(): Promise<void> {
      return tail.then(() => handle.close());
    },
  };
}
