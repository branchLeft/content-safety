import { readFile, stat } from 'node:fs/promises';
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
  let mode: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new SecretFileError(`${label}: ${path} is not a regular file`);
    mode = info.mode;
  } catch (error) {
    if (error instanceof SecretFileError) throw error;
    throw new SecretFileError(`${label}: ${path} cannot be read`);
  }
  if ((mode & 0o077) !== 0) {
    throw new SecretFileError(`${label}: ${path} is readable by group or others; restrict it to its owner`);
  }
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new SecretFileError(`${label}: ${path} cannot be read`);
  }
  const value = text.trim();
  if (value.length === 0) throw new SecretFileError(`${label}: ${path} is empty`);
  // A newline inside a header value is how one header becomes two.
  if (/[\r\n\0]/.test(value)) throw new SecretFileError(`${label}: ${path} must hold a single line`);
  return new Secret(value);
}
