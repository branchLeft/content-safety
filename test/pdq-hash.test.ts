import { describe, expect, it } from 'vitest';
import { isPdqHash, parsePdqHash } from '../src/pdq-hash.js';

describe('parsePdqHash', () => {
  it('accepts the canonical base64 of exactly 32 bytes', () => {
    const value = Buffer.alloc(32, 7).toString('base64');
    expect(parsePdqHash(value)).toBe(value);
    expect(isPdqHash(value)).toBe(true);
  });

  it('accepts the published example hash shape', () => {
    expect(parsePdqHash('0E4jZIyICuKiuE7YyxllQgH5nUJ10Y/HHVRozQuhOx0=')).toBeDefined();
  });

  const rejected: ReadonlyArray<readonly [string, unknown]> = [
    ['31 bytes', Buffer.alloc(31, 1).toString('base64')],
    ['33 bytes', Buffer.alloc(33, 1).toString('base64')],
    ['image-sized bytes', Buffer.alloc(4096, 1).toString('base64')],
    ['hex', 'ab'.repeat(32)],
    ['url-safe base64', `${'-'.repeat(43)}=`],
    ['missing padding', Buffer.alloc(32, 1).toString('base64').slice(0, 43)],
    ['non-canonical padding bits', `${'A'.repeat(42)}B=`],
    ['surrounding whitespace', ` ${Buffer.alloc(32, 1).toString('base64')}`],
    ['empty', ''],
    ['a number', 42],
    ['an object', { hashes: [] }],
    ['a buffer', Buffer.alloc(32, 1)],
    ['undefined', undefined],
  ];
  for (const [name, value] of rejected) {
    it(`rejects ${name}`, () => {
      expect(parsePdqHash(value)).toBeUndefined();
      expect(isPdqHash(value)).toBe(false);
    });
  }
});
