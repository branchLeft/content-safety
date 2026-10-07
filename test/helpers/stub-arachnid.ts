import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A local stand-in for the hash endpoint, shaped after the published
 * specification. It never forwards anything anywhere: there is no
 * credential and no live service behind any test.
 */
export interface StubEntry {
  readonly classification: string;
  readonly match_type?: string;
}

export type StubMode = 'answer' | 'never-answer' | 'server-error' | 'redirect' | 'not-json';

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly contentType: string | undefined;
  readonly body: string;
}

export interface StubArachnid {
  readonly baseUrl: string;
  readonly requests: RecordedRequest[];
  listed: Map<string, StubEntry>;
  mode: StubMode;
  close(): Promise<void>;
}

export async function startStubArachnid(listed: Map<string, StubEntry> = new Map()): Promise<StubArachnid> {
  const requests: RecordedRequest[] = [];
  const hanging = new Set<ServerResponse>();
  const state: { listed: Map<string, StubEntry>; mode: StubMode } = { listed, mode: 'answer' };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({
        method: req.method ?? '',
        path: req.url ?? '',
        authorization: req.headers.authorization,
        contentType: req.headers['content-type'],
        body,
      });
      respond(state, req, res, body, hanging);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    requests,
    get listed() {
      return state.listed;
    },
    set listed(value) {
      state.listed = value;
    },
    get mode() {
      return state.mode;
    },
    set mode(value) {
      state.mode = value;
    },
    close: async () => {
      for (const res of hanging) res.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function respond(
  state: { listed: Map<string, StubEntry>; mode: StubMode },
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
  hanging: Set<ServerResponse>
): void {
  if (state.mode === 'never-answer') {
    hanging.add(res);
    return;
  }
  if (state.mode === 'server-error') {
    res.writeHead(503).end();
    return;
  }
  if (state.mode === 'redirect') {
    res.writeHead(307, { location: '/v1/media' }).end();
    return;
  }
  if (state.mode === 'not-json') {
    res.writeHead(200, { 'content-type': 'application/json' }).end('not json');
    return;
  }
  if (req.method !== 'POST' || req.url !== '/v1/pdq') {
    res.writeHead(404).end();
    return;
  }
  const parsed = JSON.parse(body) as { hashes: string[] };
  const scanned: Record<string, StubEntry> = {};
  for (const hash of parsed.hashes) {
    scanned[hash] = state.listed.get(hash) ?? { classification: 'no-known-match' };
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ scanned_hashes: scanned }));
}
