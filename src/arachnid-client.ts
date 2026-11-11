import type { Classification, LookupResult, MatchType, PdqHash, PdqLookup } from './contract.js';
import { readBoundedText } from './bounded-body.js';
import { parsePdqHash } from './pdq-hash.js';

/**
 * The only endpoint this client can reach. The media and URL endpoints
 * would send a customer's image, or a link to it, to a third party, and
 * the contribution endpoint would need someone here to have looked at an
 * image; none of them has a code path.
 */
export const PDQ_PATH = '/v1/pdq';

/** Far above any batch's answer; past it the hash source is not answering, and every hash waiting is `unavailable`. */
export const MAX_RESPONSE_BYTES = 1024 * 1024;

const CLASSIFICATIONS: ReadonlySet<string> = new Set<Classification>([
  'csam',
  'harmful-abusive-material',
  'test',
  'no-known-match',
]);
const MATCH_TYPES: ReadonlySet<string> = new Set<MatchType>(['exact', 'near']);

/**
 * A lookup the hash source refused, named by a fixed outcome: `http-<status>`
 * or `redirect-refused`. It carries no header, no body and no URL, so it is
 * safe to log whole.
 */
export class HashLookupError extends Error {
  constructor(readonly outcome: string) {
    super(
      outcome.startsWith('http-')
        ? `hash lookup answered HTTP ${outcome.slice('http-'.length)}`
        : 'hash lookup was redirected and the redirect was refused'
    );
    this.name = 'HashLookupError';
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ArachnidPdqClientOptions {
  /** Required on purpose: no default can point a test at the live service. */
  readonly baseUrl: string;
  /** Produces the Authorization header value. Never logged, never audited. */
  readonly authorization: () => string;
  readonly fetch?: FetchLike;
}

/** The whole request body. Typed so that nothing but hashes can be put in it. */
export interface PdqRequestBody {
  readonly hashes: readonly PdqHash[];
}

export function buildPdqRequestBody(hashes: readonly PdqHash[]): string {
  const body: PdqRequestBody = { hashes: hashes.map(assertHash) };
  return JSON.stringify(body);
}

function assertHash(hash: PdqHash): PdqHash {
  if (parsePdqHash(hash) === undefined) {
    throw new TypeError('refusing to send a value that is not a PDQ hash');
  }
  return hash;
}

/**
 * Reads `{ scanned_hashes: { <hash>: { classification, match_type } } }`.
 * An entry this cannot read is left out rather than guessed at, so it has
 * no verdict and becomes `unavailable` upstream.
 */
export function parsePdqResponse(
  payload: unknown,
  asked: readonly PdqHash[]
): ReadonlyMap<PdqHash, LookupResult> {
  const out = new Map<PdqHash, LookupResult>();
  if (!isRecord(payload) || !isRecord(payload.scanned_hashes)) return out;
  const scanned = payload.scanned_hashes;
  for (const hash of asked) {
    const entry = Object.prototype.hasOwnProperty.call(scanned, hash) ? scanned[hash] : undefined;
    if (!isRecord(entry) || typeof entry.classification !== 'string') continue;
    if (!CLASSIFICATIONS.has(entry.classification)) continue;
    const classification = entry.classification as Classification;
    const matchType =
      typeof entry.match_type === 'string' && MATCH_TYPES.has(entry.match_type)
        ? (entry.match_type as MatchType)
        : undefined;
    out.set(hash, matchType === undefined ? { classification } : { classification, matchType });
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `fetch` reports `redirect: 'error'` as a TypeError whose cause says so; the stub tests run it for real. */
function wasRedirectRefused(error: unknown): boolean {
  return error instanceof TypeError && error.cause instanceof Error && error.cause.message === 'unexpected redirect';
}

export class ArachnidPdqClient implements PdqLookup {
  readonly #url: string;
  readonly #authorization: () => string;
  readonly #fetch: FetchLike;

  constructor(options: ArachnidPdqClientOptions) {
    this.#url = new URL(PDQ_PATH, options.baseUrl).toString();
    this.#authorization = options.authorization;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
  }

  async lookup(hashes: readonly PdqHash[], signal: AbortSignal): Promise<ReadonlyMap<PdqHash, LookupResult>> {
    let response: Response;
    try {
      response = await this.#fetch(this.#url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: this.#authorization(),
        },
        body: buildPdqRequestBody(hashes),
        signal,
        redirect: 'error',
      });
    } catch (error) {
      throw wasRedirectRefused(error) ? new HashLookupError('redirect-refused') : error;
    }
    if (!response.ok) {
      throw new HashLookupError(`http-${String(response.status)}`);
    }
    return parsePdqResponse(JSON.parse(await readBoundedText(response, MAX_RESPONSE_BYTES)), hashes);
  }
}
