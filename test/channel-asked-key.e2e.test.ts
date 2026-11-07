import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../src/arachnid-client.js';
import { PENDING_PATH, VERDICTS_PATH } from '../src/channel-contract.js';
import { startService, type RunningService } from '../src/service-runner.js';
import { hashOf } from './helpers/fixtures.js';
import { startRig, type Rig } from './helpers/rig.js';

/** A hash the hash source volunteers without being asked: no host offered it, so no verdict may carry it. */
const VOLUNTEERED = hashOf(9);
/** A hash the hash source leaves out of its first answer, so the service must answer it `unavailable`. */
const LEFT_OUT_ONCE = hashOf(4);

interface Poll {
  readonly batch: string;
  readonly hashes: readonly string[];
}

interface PostedBody {
  readonly batch: string;
  readonly verdicts: readonly { readonly hash: string; readonly classification: string }[];
}

let rig: Rig | undefined;
let running: RunningService | undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
  await rig?.dispose();
  rig = undefined;
});

/**
 * The service's own fetch, with the host's poll answers and the hash source's
 * answers recorded. It changes only the hash source's answer: one hash it was
 * asked about is left out once, and one it was not asked about is added to
 * every answer.
 */
function observedFetch(hashSourceBase: string, polls: Poll[]): FetchLike {
  let leftOut = false;
  return async (url, init) => {
    const response = await fetch(url, init);
    if (url.endsWith(PENDING_PATH) && response.ok) {
      const payload = (await response.clone().json()) as { batch?: string; hashes: string[] };
      if (payload.batch !== undefined && payload.hashes.length > 0) {
        polls.push({ batch: payload.batch, hashes: payload.hashes });
      }
      return response;
    }
    if (url.startsWith(hashSourceBase) && response.ok) {
      const payload = (await response.json()) as { scanned_hashes: Record<string, unknown> };
      const scanned: Record<string, unknown> = { ...payload.scanned_hashes };
      if (!leftOut && LEFT_OUT_ONCE in scanned) {
        delete scanned[LEFT_OUT_ONCE];
        leftOut = true;
      }
      scanned[VOLUNTEERED] = { classification: 'csam', match_type: 'exact' };
      return new Response(JSON.stringify({ scanned_hashes: scanned }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return response;
  };
}

describe('the asked key on the wire, end to end, against a hash source that adds and omits', () => {
  it('posts each polled hash once, under the batch it was polled in, and never a volunteered hash', async () => {
    rig = await startRig({
      listed: new Map([
        [hashOf(1), { classification: 'csam', match_type: 'exact' }],
        [hashOf(3), { classification: 'test', match_type: 'near' }],
      ]),
    });
    const polls: Poll[] = [];
    // Both first-round hashes are queued before the service polls, so one batch carries both.
    const firstRound = [rig.host.submit(hashOf(1)), rig.host.submit(hashOf(2))];
    running = await startService(rig.config, {
      log: () => undefined,
      fetch: observedFetch(rig.config.arachnid.baseUrl, polls),
    });
    const [exact, clean] = await Promise.all(firstRound);
    const secondRound = [rig.host.submit(hashOf(3)), rig.host.submit(LEFT_OUT_ONCE)];
    const [near, unavailable] = await Promise.all(secondRound);

    expect(exact).toMatchObject({ classification: 'csam', matchType: 'exact' });
    expect(clean.classification).toBe('no-known-match');
    expect(near).toMatchObject({ classification: 'test', matchType: 'near' });
    expect(unavailable.classification).toBe('unavailable');

    // The unavailable hash is offered again, and its settled answer must be posted too.
    await vi.waitFor(() => {
      expect(rig?.host.history(LEFT_OUT_ONCE).at(-1)?.classification).toBe('no-known-match');
    });

    const posted = rig.host.requests
      .filter((request) => request.method === 'POST' && request.path === VERDICTS_PATH && request.signatureVerified)
      .map((request) => JSON.parse(request.body) as PostedBody);

    // The first batch holds two hashes, so an entry shifted to a neighbour's key is visible.
    expect(polls[0]?.hashes).toHaveLength(2);
    expect(polls.length).toBeGreaterThanOrEqual(3);
    for (const poll of polls) {
      // Each poll's batch name is echoed on exactly one answer, which carries exactly the polled hashes, each once.
      const answers = posted.filter((body) => body.batch === poll.batch);
      expect(answers).toHaveLength(1);
      expect(answers[0]?.verdicts.map((verdict) => verdict.hash).sort()).toEqual([...poll.hashes].sort());
    }
    // No answer goes under a batch name that was never polled.
    expect(posted.every((body) => polls.some((poll) => poll.batch === body.batch))).toBe(true);

    const everyPostedHash = posted.flatMap((body) => body.verdicts.map((verdict) => verdict.hash));
    expect(everyPostedHash).not.toContain(VOLUNTEERED);
    expect(polls.flatMap((poll) => poll.hashes)).not.toContain(VOLUNTEERED);
    expect(
      posted.some((body) =>
        body.verdicts.some((verdict) => verdict.hash === LEFT_OUT_ONCE && verdict.classification === 'unavailable')
      )
    ).toBe(true);
  });
});
