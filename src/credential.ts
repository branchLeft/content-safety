import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { inspect } from 'node:util';

const REDACTED = '[redacted]';

/**
 * Every message here names the file and the reason and never its content:
 * the process logs these errors verbatim when it refuses to start.
 */
export class SecretFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretFileError';
  }
}

/**
 * A value that stringifies, serialises and inspects as a placeholder; the
 * only way to it is `reveal`, which has one caller per secret.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}

/**
 * Never an environment value, which children inherit and diagnostics show.
 * A file readable by anyone but its owner is refused outright.
 */
export async function readSecretFile(path: string, label: string): Promise<Secret> {
  if (path.length === 0) throw new SecretFileError(`${label}: no file path is configured`);
  // Opened once, and every check and the read go through that one
  // descriptor: a path checked and then read again can be swapped between
  // the two. A symbolic link is refused at the open.
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const link = (error as NodeJS.ErrnoException).code === 'ELOOP';
    throw new SecretFileError(
      link ? `${label}: ${path} is a symbolic link; name the file itself` : `${label}: ${path} cannot be read`
    );
  }
  let text: string;
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new SecretFileError(`${label}: ${path} is not a regular file`);
    if ((info.mode & 0o077) !== 0) {
      throw new SecretFileError(`${label}: ${path} is readable by group or others; restrict it to its owner`);
    }
    text = await handle.readFile('utf8');
  } catch (error) {
    if (error instanceof SecretFileError) throw error;
    throw new SecretFileError(`${label}: ${path} cannot be read`);
  } finally {
    await handle.close();
  }
  const value = text.trim();
  if (value.length === 0) throw new SecretFileError(`${label}: ${path} is empty`);
  // A newline inside a header value is how one header becomes two.
  if (/[\r\n\0]/.test(value)) throw new SecretFileError(`${label}: ${path} must hold a single line`);
  return new Secret(value);
}
