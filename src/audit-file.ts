import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';

export class AuditFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditFileError';
  }
}

export interface AuditFile {
  /** Appends one line and returns once it is on disk. */
  write(line: string): Promise<void>;
  close(): Promise<void>;
}

interface Group {
  flushed: boolean;
  readonly lines: string[];
  readonly waiters: { resolve: () => void; reject: (error: unknown) => void }[];
}

const NEWLINE = 0x0a;

/**
 * Append-only, owner-only, synced before a write counts as done. Lines
 * written in one turn share one append and one sync, not a sync per hash.
 */
export async function openAuditFile(path: string): Promise<AuditFile> {
  const handle: FileHandle = await open(
    path,
    constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600
  );
  let prefix = '';
  try {
    const info = await handle.stat();
    // The mode given to `open` applies only when it creates the file.
    if ((info.mode & 0o077) !== 0) {
      throw new AuditFileError(`audit file: ${path} is readable by group or others; restrict it to its owner`);
    }
    if (info.size > 0) {
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, info.size - 1);
      // A torn last line must not swallow the next record.
      if (last[0] !== NEWLINE) prefix = '\n';
    }
  } catch (error) {
    await handle.close();
    throw error;
  }

  let current: Group | undefined;
  let tail: Promise<void> = Promise.resolve();

  const flush = (group: Group): void => {
    if (group.flushed) return;
    group.flushed = true;
    if (current === group) current = undefined;
    tail = tail.then(async () => {
      try {
        const text = prefix + group.lines.join('');
        await handle.appendFile(text, 'utf8');
        prefix = '';
        await handle.datasync();
        for (const waiter of group.waiters) waiter.resolve();
      } catch (error) {
        // A failed group fails its own writers only, not every later one.
        for (const waiter of group.waiters) waiter.reject(error);
      }
    });
  };

  return {
    write(line: string): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const text = String(line);
        if (current === undefined) {
          const group: Group = { flushed: false, lines: [], waiters: [] };
          current = group;
          queueMicrotask(() => flush(group));
        }
        current.lines.push(text);
        current.waiters.push({ resolve, reject });
      });
    },
    close(): Promise<void> {
      if (current !== undefined) flush(current);
      return tail.then(() => handle.close());
    },
  };
}
