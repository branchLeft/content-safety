import { stat } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parsePdqHash } from '../src/pdq-hash.js';
import { admits, parseVerdictsBody } from '../src/verdict-schema.js';
import { hashOf } from './helpers/fixtures.js';
import { makeSigningKey } from './helpers/keys.js';
import { SENTINEL_AUTHORIZATION, SENTINEL_PASSWORD, SENTINEL_USERNAME, startRig, type Rig } from './helpers/rig.js';
import { STUB_REFUSAL_BODY } from './helpers/stub-arachnid.js';

let rig: Rig | undefined;

afterEach(async () => {
  await rig?.dispose();
  rig = undefined;
});

const csamExact = { classification: 'csam', match_type: 'exact' };

describe('the verdict channel, end to end, with a host that only listens', () => {
  it('dials in, takes the hashes and returns each verdict to the host caller', async () => {
    rig = await startRig({
      listed: new Map([
        [hashOf(1), csamExact],
        [hashOf(3), { classification: 'test', match_type: 'near' }],
      ]),
    });
    await rig.start();

    const [exact, clean, control] = await Promise.all([
      rig.host.submit(hashOf(1)),
      rig.host.submit(hashOf(2)),
      rig.host.submit(hashOf(3)),
    ]);

    expect(exact.classification).toBe('csam');
    expect(exact.matchType).toBe('exact');
    expect(exact.decision).toMatchObject({ action: 'refuse', tier: 'two', irreversible: true, control: false });
    expect(exact.decision['steps']).toContain('kill-slot-quietly');
    expect(exact.audited).toBe(true);
    expect(clean.classification).toBe('no-known-match');
    expect(clean.decision).toEqual({ action: 'allow' });
    expect(control.decision).toMatchObject({ action: 'refuse', tier: 'one', irreversible: false, control: true });

    // The host never dialled anything and the service signed everything it sent.
    expect(rig.host.requests.length).toBeGreaterThan(1);
    expect(rig.host.requests.every((request) => request.signatureVerified)).toBe(true);
    expect(new Set(rig.host.requests.map((request) => `${request.method} ${request.path}`))).toEqual(
      new Set(['GET /safety/v1/pending', 'POST /safety/v1/verdicts'])
    );
    expect(await rig.auditLines()).toHaveLength(3);
  });

  it('keeps a live tenant serving on an exact match, where a demo slot is killed', async () => {
    rig = await startRig({ hostKind: 'tenant', listed: new Map([[hashOf(1), csamExact]]) });
    await rig.start();

    const verdict = await rig.host.submit(hashOf(1));

    expect(verdict.decision['steps']).toContain('keep-site-serving');
    expect(verdict.decision['steps']).not.toContain('kill-slot-quietly');
  });

  it('answers unavailable within the timeout when the hash source never answers, then recovers', async () => {
    rig = await startRig({ arachnidTimeoutMs: 200 });
    rig.arachnid.mode = 'never-answer';
    await rig.start();

    const started = Date.now();
    const held = await rig.host.submit(hashOf(7));

    expect(Date.now() - started).toBeLessThan(1500);
    expect(held.classification).toBe('unavailable');
    expect(held.decision).toEqual({ action: 'hold', reason: 'unavailable' });

    // The host keeps an unavailable hash queued, so a source that comes back settles it.
    rig.arachnid.mode = 'answer';
    await vi.waitFor(() => {
      const latest = rig?.host.history(hashOf(7)).at(-1);
      expect(latest?.classification).toBe('no-known-match');
    });
  });

  it('lets an upload pass only on a clean verdict, whatever the hash source does', async () => {
    rig = await startRig({ arachnidTimeoutMs: 200, listed: new Map([[hashOf(1), csamExact]]) });
    await rig.start();
    const mayPassNow = (hash: string): boolean => {
      const posted = rig?.host.requests.filter((request) => request.method === 'POST') ?? [];
      return posted.some((request) => {
        const body = parseVerdictsBody(JSON.parse(request.body));
        const entry = body?.verdicts.find((candidate) => candidate.hash === hash);
        return entry !== undefined && admits(entry);
      });
    };

    await rig.host.submit(hashOf(1));
    await rig.host.submit(hashOf(2));
    expect(mayPassNow(hashOf(1))).toBe(false);
    expect(mayPassNow(hashOf(2))).toBe(true);

    for (const [index, mode] of (['never-answer', 'server-error', 'redirect'] as const).entries()) {
      rig.arachnid.mode = mode;
      const held = await rig.host.submit(hashOf(10 + index));
      expect(held.classification).toBe('unavailable');
      expect(mayPassNow(hashOf(10 + index))).toBe(false);
    }
    // Every body the service posted is one a host can read.
    for (const request of rig.host.requests.filter((candidate) => candidate.method === 'POST')) {
      expect(parseVerdictsBody(JSON.parse(request.body))).toBeDefined();
    }
  });

  it('sends only hashes upstream, and never lets a value that is not a hash reach the source', async () => {
    rig = await startRig({ listed: new Map([[hashOf(1), csamExact]]) });
    rig.host.enqueueRaw('https://example.invalid/upload.png');
    rig.host.enqueueRaw('not-a-hash');
    rig.host.enqueueRaw(42);
    await rig.start();

    const verdict = await rig.host.submit(hashOf(1));

    expect(verdict.classification).toBe('csam');
    expect(rig.arachnid.requests.length).toBeGreaterThan(0);
    for (const request of rig.arachnid.requests) {
      expect(request.method).toBe('POST');
      expect(request.path).toBe('/v1/pdq');
      const body = JSON.parse(request.body) as { hashes: string[] };
      expect(Object.keys(body)).toEqual(['hashes']);
      expect(body.hashes.every((hash) => parsePdqHash(hash) !== undefined)).toBe(true);
      expect(request.body).not.toContain('example.invalid');
      expect(request.body).not.toContain('HOST_A');
    }
  });

  it('shows the credential in no log line, audit record, host request or upstream body', async () => {
    rig = await startRig({ listed: new Map([[hashOf(1), csamExact]]) });
    await rig.start();
    await rig.host.submit(hashOf(1));
    rig.arachnid.mode = 'server-error';
    await rig.host.submit(hashOf(2));

    // Each half, and the encoded header that carries both.
    const secretParts = [SENTINEL_USERNAME, SENTINEL_PASSWORD, SENTINEL_AUTHORIZATION, SENTINEL_AUTHORIZATION.slice('Basic '.length)];
    expect(rig.logs.length).toBeGreaterThan(0);
    for (const secretPart of secretParts) {
      expect(rig.logs.join('\n')).not.toContain(secretPart);
      expect((await rig.auditLines()).join('\n')).not.toContain(secretPart);
      expect(JSON.stringify(rig.host.requests)).not.toContain(secretPart);
      expect(rig.arachnid.requests.map((request) => request.body).join('\n')).not.toContain(secretPart);
    }
    // The pair was used: the hash source was shown HTTP Basic for it, as the header value.
    expect(rig.arachnid.requests[0]?.authorization).toBe(SENTINEL_AUTHORIZATION);
  });

  it('is not recognised by a host that holds a different public key, and asks the source for nothing', async () => {
    rig = await startRig({ key: makeSigningKey(), hostKey: makeSigningKey() });
    await rig.start();
    const answered = vi.fn();
    void rig.host.submit(hashOf(1)).then(answered);

    await vi.waitFor(() => {
      expect(rig?.logs.some((line) => line.includes('"host-answered-401"'))).toBe(true);
    });

    expect(answered).not.toHaveBeenCalled();
    expect(rig.host.requests.every((request) => !request.signatureVerified)).toBe(true);
    expect(rig.arachnid.requests).toHaveLength(0);
  });

  it('keeps its audit trail across a restart and appends to it', async () => {
    rig = await startRig();
    const first = await rig.start();
    await rig.host.submit(hashOf(1));
    await first.stop();
    const before = await rig.auditLines();

    const second = await rig.start();
    await rig.host.submit(hashOf(2));
    // The cache is per process: the same hash costs one more lookup after a restart.
    const lookupsBefore = rig.arachnid.requests.length;
    await rig.host.submit(hashOf(1));
    await second.stop();
    const after = await rig.auditLines();

    expect(before).toHaveLength(1);
    expect(after).toHaveLength(3);
    expect(after[0]).toBe(before[0]);
    expect(rig.arachnid.requests.length).toBe(lookupsBefore + 1);
    expect(((await stat(rig.auditPath)).mode & 0o777).toString(8)).toBe('600');
  });

  it('stops promptly while a poll is held open on the host', async () => {
    rig = await startRig({ holdMs: 5000 });
    const service = await rig.start();
    await vi.waitFor(() => {
      expect(rig?.host.requests.length).toBeGreaterThan(0);
    });

    const started = Date.now();
    await service.stop();

    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('the credential and a degraded round, end to end', () => {
  const outcomesLogged = (r: Rig): string[] =>
    r.logs
      .map((line) => JSON.parse(line) as { event: string; outcome?: string })
      .filter((entry) => entry.event === 'hash-lookup-failed')
      .map((entry) => entry.outcome ?? '');

  it('sends a password with a leading and a trailing space exactly as it was written', async () => {
    const password = ' TEST_SENTINEL_PASS_EDGES ';
    rig = await startRig({ password });
    await rig.start();

    await rig.host.submit(hashOf(1));

    const expected = `Basic ${Buffer.from(`${SENTINEL_USERNAME}:${password}`, 'utf8').toString('base64')}`;
    expect(rig.arachnid.requests[0]?.authorization).toBe(expected);
  });

  it('logs the status on a refused lookup and says redirect-refused for a refused redirect', async () => {
    rig = await startRig();
    await rig.start();

    rig.arachnid.mode = 'unauthorized';
    await rig.host.submit(hashOf(1));
    rig.arachnid.mode = 'redirect';
    await rig.host.submit(hashOf(2));

    const outcomes = outcomesLogged(rig);
    expect(outcomes).toContain('http-401');
    expect(outcomes).toContain('redirect-refused');
  });

  it('logs no credential, header or response body on a refused lookup', async () => {
    rig = await startRig();
    await rig.start();
    rig.arachnid.mode = 'unauthorized';

    await rig.host.submit(hashOf(1));

    expect(outcomesLogged(rig)).toContain('http-401');
    const logged = rig.logs.join('\n');
    for (const secretPart of [
      SENTINEL_USERNAME,
      SENTINEL_PASSWORD,
      SENTINEL_AUTHORIZATION,
      SENTINEL_AUTHORIZATION.slice('Basic '.length),
      STUB_REFUSAL_BODY,
      'authorization',
    ]) {
      expect(logged.toLowerCase()).not.toContain(secretPart.toLowerCase());
    }
  });
});
