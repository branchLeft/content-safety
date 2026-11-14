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
 * The hash source takes HTTP Basic (RFC 7617): a username and a password, not
 * one token. The first colon splits the pair, so a colon in the username would
 * move the split; a colon in the password is fine. The result is the whole
 * header value, held as a `Secret` so it logs and serialises as a placeholder.
 * Messages name the half and never its content.
 */
export function basicAuthorization(username: Secret, password: Secret): Secret {
  for (const [label, half] of [
    ['hash source username', username.reveal()],
    ['hash source password', password.reveal()],
  ] as const) {
    if (half.length === 0) throw new SecretFileError(`${label}: is empty`);
    if (/[\u0000-\u001f\u007f]/.test(half)) throw new SecretFileError(`${label}: holds a control character`);
  }
  if (username.reveal().includes(':')) {
    throw new SecretFileError('hash source username: must not contain a colon');
  }
  const pair = Buffer.from(`${username.reveal()}:${password.reveal()}`, 'utf8');
  return new Secret(`Basic ${pair.toString('base64')}`);
}

export interface ReadSecretFileOptions {
  /**
   * Strip one trailing line ending and nothing else, for a value whose leading
   * and trailing spaces are part of it (a password). Left out, every
   * surrounding space is trimmed, which is right for a name or a key.
   */
  readonly stripLineEndingOnly?: boolean;
}

/**
 * Never an environment value, which children inherit and diagnostics show.
 * A file readable by anyone but its owner is refused outright.
 */
export async function readSecretFile(
  path: string,
  label: string,
  options: ReadSecretFileOptions = {}
): Promise<Secret> {
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
  const value = options.stripLineEndingOnly === true ? text.replace(/\r?\n$/, '') : text.trim();
  // A value of nothing but spaces is a blank file, not a password.
  if (value.trim().length === 0) throw new SecretFileError(`${label}: ${path} is empty`);
  // A newline inside a header value is how one header becomes two.
  if (/[\r\n\0]/.test(value)) throw new SecretFileError(`${label}: ${path} must hold a single line`);
  return new Secret(value);
}
