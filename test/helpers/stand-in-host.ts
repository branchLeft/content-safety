import { verify, type KeyObject } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A host's end of the channel. It only listens, and checks signatures with
 * its own reading of the signing rules, not the service's code.
 */
export interface HostVerdict {
  readonly hash: string;
  readonly classification: string;
  readonly matchType?: string;
  readonly source: string;
  readonly decision: { readonly action: string; readonly [key: string]: unknown };
  readonly audited: boolean;
}

export interface HostRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
  readonly signatureVerified: boolean;
}

export interface StandInHost {
  readonly endpoint: string;
  readonly requests: HostRequest[];
  /** The host's caller: resolves at the first verdict for this hash, whatever it is. */
  submit(hash: string, maxWaitMs?: number): Promise<HostVerdict>;
  /** Puts a value into the queue as given, with no caller waiting on it. */
  enqueueRaw(value: unknown): void;
  /** Every verdict the service returned for a hash, in order. */
  history(hash: string): readonly HostVerdict[];
  /** Items waiting for a verdict, including ones the service answered `unavailable`. */
  queued(): number;
  close(): Promise<void>;
}

const NO_ANSWER = (hash: string): HostVerdict => ({
  hash,
  classification: 'NO-ANSWER-WITHIN-BUDGET',
  source: 'stand-in-host',
  decision: { action: 'none' },
  audited: false,
});

interface Item {
  readonly hash: unknown;
  waiter?: ((verdict: HostVerdict) => void) | undefined;
}

export interface StandInOptions {
  readonly publicKey: KeyObject;
  readonly holdMs?: number;
}


export async function startStandInHost(options: StandInOptions): Promise<StandInHost> {
  const holdMs = options.holdMs ?? 100;
  const requests: HostRequest[] = [];
  const queue: Item[] = [];
  const leases = new Map<string, Item[]>();
  const histories = new Map<string, HostVerdict[]>();
  const wakers = new Set<() => void>();
  const nonces = new Set<string>();
  let batchCounter = 0;

  const signatureOk = (req: IncomingMessage, body: string): boolean => {
    const timestamp = req.headers['x-broker-timestamp'];
    const nonce = req.headers['x-broker-nonce'];
    const signature = req.headers['x-broker-signature'];
    if (typeof timestamp !== 'string' || typeof nonce !== 'string' || typeof signature !== 'string') return false;
    if (!/^[A-Za-z0-9._-]{16,128}$/.test(nonce) || nonces.has(nonce)) return false;
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 60) return false;
    const signed = Buffer.concat([
      Buffer.from(`${req.method ?? ''}\n${req.url ?? ''}\n${timestamp}\n${nonce}\n`, 'utf8'),
      Buffer.from(body, 'utf8'),
    ]);
    const ok = verify(null, signed, options.publicKey, Buffer.from(signature, 'base64'));
    if (ok) nonces.add(nonce);
    return ok;
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const verified = signatureOk(req, body);
      requests.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body, signatureVerified: verified });
      if (!verified) {
        res.writeHead(401).end();
        return;
      }
      if (req.method === 'GET' && req.url === '/safety/v1/pending') {
        handlePoll(res);
        return;
      }
      if (req.method === 'POST' && req.url === '/safety/v1/verdicts') {
        handleVerdicts(res, body);
        return;
      }
      res.writeHead(404).end();
    });
  });

  function lease(): Item[] {
    return queue.splice(0, 500);
  }

  function answerPoll(res: ServerResponse): void {
    const items = lease();
    if (items.length === 0) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ v: 1, hashes: [] }));
      return;
    }
    batchCounter += 1;
    const batch = `stand-in-batch-${String(batchCounter).padStart(6, '0')}`;
    leases.set(batch, items);
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ v: 1, batch, hashes: items.map((item) => item.hash) }));
  }

  function handlePoll(res: ServerResponse): void {
    if (queue.length > 0) {
      answerPoll(res);
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      wakers.delete(finish);
      if (!res.writableEnded && !res.destroyed) answerPoll(res);
    };
    const timer = setTimeout(finish, holdMs);
    wakers.add(finish);
    res.on('close', () => {
      clearTimeout(timer);
      wakers.delete(finish);
    });
  }

  function handleVerdicts(res: ServerResponse, body: string): void {
    const parsed = JSON.parse(body) as { batch: string; verdicts: HostVerdict[] };
    const items = leases.get(parsed.batch);
    if (items === undefined) {
      res.writeHead(409).end();
      return;
    }
    leases.delete(parsed.batch);
    const answered = new Set<Item>();
    for (const verdict of parsed.verdicts) {
      const item = items.find((candidate) => candidate.hash === verdict.hash && !answered.has(candidate));
      if (item === undefined) continue;
      answered.add(item);
      const list = histories.get(verdict.hash) ?? [];
      list.push(verdict);
      histories.set(verdict.hash, list);
      const waiter = item.waiter;
      item.waiter = undefined;
      waiter?.(verdict);
      // An unavailable answer settles nothing: the host keeps the hash queued.
      if (verdict.classification === 'unavailable') queue.push(item);
    }
    for (const item of items) if (!answered.has(item)) queue.push(item);
    res.writeHead(204).end();
    for (const wake of [...wakers]) wake();
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    endpoint: `http://127.0.0.1:${String(port)}`,
    requests,
    submit(hash: string, maxWaitMs = 3000): Promise<HostVerdict> {
      return new Promise((resolve) => {
        // A bounded wait, so a service that never answers fails an assertion
        // on this value instead of hanging the test until its own timeout.
        const timer = setTimeout(() => resolve(NO_ANSWER(hash)), maxWaitMs);
        timer.unref();
        queue.push({
          hash,
          waiter: (verdict) => {
            clearTimeout(timer);
            resolve(verdict);
          },
        });
        for (const wake of [...wakers]) wake();
      });
    },
    enqueueRaw(value: unknown): void {
      queue.push({ hash: value });
      for (const wake of [...wakers]) wake();
    },
    history: (hash) => histories.get(hash) ?? [],
    queued: () => queue.length,
    close: async () => {
      for (const wake of [...wakers]) wake();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
