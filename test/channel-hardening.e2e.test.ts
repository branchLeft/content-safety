import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_BODY_BYTES } from '../src/channel-contract.js';
import { Secret } from '../src/credential.js';
import { HostChannel } from '../src/host-channel.js';
import { RequestSigner } from '../src/request-signer.js';
import { DEMO, hashOf } from './helpers/fixtures.js';
import { makeSigningKey } from './helpers/keys.js';
import { startRig, type Rig } from './helpers/rig.js';

let rig: Rig | undefined;
let server: Server | undefined;

afterEach(async () => {
  await rig?.dispose();
  rig = undefined;
  if (server !== undefined) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
});

describe('a host that streams an answer without end, over a real socket', () => {
  it('is cut off soon after the bound and the connection is closed', async () => {
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    const seen = { written: 0, closedByClient: false };
    server = createServer((_req, res: ServerResponse) => {
      // No content-length: chunked, for as long as the client keeps reading.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.on('close', () => {
        seen.closedByClient = true;
      });
      const pump = (): void => {
        while (!seen.closedByClient && seen.written < 64 * 1024 * 1024) {
          seen.written += chunk.length;
          if (!res.write(chunk)) {
            res.once('drain', pump);
            return;
          }
        }
      };
      pump();
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const logs: string[] = [];
    const channel = new HostChannel({
      host: { id: 'HOST_A', kind: 'demo', safety: DEMO.safety, endpoint: `http://127.0.0.1:${String(port)}` },
      assess: async () => [],
      signer: new RequestSigner(new Secret(makeSigningKey().seedBase64)),
      log: (event, fields) => logs.push(`${event} ${JSON.stringify(fields)}`),
      pollTimeoutMs: 5000,
      postTimeoutMs: 5000,
      minPollGapMs: 0,
      backoffBaseMs: 10,
      backoffMaxMs: 10,
    });

    expect(await channel.runOnce()).toBe('failed');

    expect(logs).toEqual(['poll-failed {"host":"HOST_A","reason":"response-too-large"}']);
    await vi.waitFor(() => expect(seen.closedByClient).toBe(true));
    // Socket buffers hold some of what the host wrote after the cut; a read
    // of the whole 256 MiB would put this two orders of magnitude higher.
    expect(seen.written).toBeLessThan(MAX_BODY_BYTES + 16 * 1024 * 1024);
  });
});

describe('a hash source that is down, and a host that offers its hashes again at once', () => {
  it('does not turn the outage into a stream of requests against the source', async () => {
    rig = await startRig({ arachnidTimeoutMs: 200 });
    rig.arachnid.mode = 'server-error';
    await rig.start();
    void rig.host.submit(hashOf(1), 60_000);

    await new Promise((resolve) => setTimeout(resolve, 800));

    // The rig backs off from 10 ms to a ceiling of 50 ms, so about 16 rounds
    // fit in the window; with no backoff the same window holds hundreds.
    const asked = rig.arachnid.requests.length;
    expect(asked).toBeGreaterThan(2);
    expect(asked).toBeLessThan(40);
  });
});

describe('a full batch', () => {
  it('is audited and answered in full within the audit budget', async () => {
    rig = await startRig();
    const hashes = Array.from({ length: 500 }, (_, i) => {
      const bytes = Buffer.alloc(32, 7);
      bytes.writeUInt16BE(i, 0);
      return bytes.toString('base64');
    });
    // Queued before the service starts, so the host hands them over as one batch.
    const answers = hashes.map((hash) => rig?.host.submit(hash, 15_000));
    await rig.start();

    const settled = await Promise.all(answers);

    expect(rig.host.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
    expect(settled.every((answer) => answer?.classification === 'no-known-match' && answer.audited)).toBe(true);
    expect((await rig.auditLines()).length).toBe(500);
  });
});
