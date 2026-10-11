# The verdict channel, version 1

The wire contract between the safety service and a host. A host is a demo or tenant machine that holds uploaded media and needs a verdict on each upload's perceptual hash. This file is the single statement of the contract: the host end is built against it, and the service end (`src/channel-contract.ts`, `src/host-channel.ts`) is tested against it.

## Direction and what crosses

- **The service dials; the host answers.** A host holds no hash-source credential, opens no outbound connection for this and never calls the service. The service holds no listener at all.
- **Only PDQ hashes cross, in both directions.** The host never sends bytes, paths, names, URLs or tenant data; the service never receives them. A value that is not the canonical base64 of exactly 32 bytes is dropped on arrival and gets no verdict.
- **The estate comes from the service's own configuration**, never from what a host says about itself.

## Transport

HTTP/1.1 with JSON bodies, one document per request or response, at most 262144 bytes (`MAX_BODY_BYTES`). The bound is on bytes, and the service enforces it as the body arrives: it counts the bytes it reads and cancels the stream once the count passes the bound, for a poll answer and for the answer to a verdict post alike, so a host cannot make it buffer more. An answer over the bound is a failure. The service refuses redirects. Plain `http` is accepted only for a loopback address; every other endpoint must be `https`. An endpoint is an origin: no path, query, fragment or embedded credentials.

## How the host recognises the service

Every request carries three headers, in the scheme the platform's broker already uses:

| Header | Value |
|---|---|
| `x-broker-timestamp` | whole seconds since the Unix epoch, decimal |
| `x-broker-nonce` | 16 to 128 characters from `[A-Za-z0-9._-]`, never reused |
| `x-broker-signature` | base64 of a raw Ed25519 signature |

The signature covers `METHOD\nPATH\nTIMESTAMP\nNONCE\n` followed by the exact request body bytes (empty for a poll). The host holds only the public key, which is not a credential. A host refuses, with 401 and no body, a request whose signature does not verify or whose nonce it has seen, and applies the broker's own replay rules to the timestamp: a window behind the host's clock, at most 5 seconds of forward skew, and nothing at or before the host process's start time (its nonce store is in memory, so a restart forgets every nonce). The signed bytes name no audience, which is the broker's existing scheme: the same signed request verifies at any host holding the key, once per host's nonce store.

## Poll: `GET /safety/v1/pending`

No query string and no body. The host holds the request open until it has hashes to hand over or its own hold time passes (about 30 seconds; incidental), then answers 200:

```json
{ "v": 1, "batch": "BATCH_NAME", "hashes": ["BASE64_PDQ_HASH"] }
```

- `batch` is 16 to 128 characters from `[A-Za-z0-9._-]`. It names the host's lease on these hashes and is echoed back.
- `hashes` holds at most 500 entries (`MAX_BATCH_HASHES`). Entries past 500 are not answered; the host offers them again.
- An empty hold is `{ "v": 1, "hashes": [] }`, where `batch` may be left out.
- The service's own deadline for a poll is longer than the host's hold (default 40 seconds), and a poll that fails is retried with exponential backoff (default 1 second, ceiling 30 seconds). An empty answer that came back at once is not re-polled for a minimum gap (default 250 milliseconds).

## Verdicts: `POST /safety/v1/verdicts`

```json
{
  "v": 1,
  "batch": "BATCH_NAME",
  "verdicts": [
    {
      "hash": "BASE64_PDQ_HASH",
      "classification": "csam | harmful-abusive-material | test | no-known-match | unavailable",
      "matchType": "exact | near",
      "source": "SOURCE_NAME",
      "decision": { "action": "allow" },
      "audited": true
    }
  ]
}
```

- `matchType` is present only when the source gave one.
- `decision` is the service's one policy applied to the verdict, in one of three shapes: `{ "action": "allow" }`, `{ "action": "hold", "reason": "unavailable | context-rejected | audit-unavailable" }`, or `{ "action": "refuse", "tier": "one | two", "irreversible": bool, "control": bool, "steps": [...] }`. `steps` names what the host is asked to do; the host acts on the ones that are its own and ignores the rest.
- `audited: false` means no record of the decision was written; the decision stands.
- **`unavailable` means "no answer": the host holds the upload and keeps the hash queued to be offered again.** Every hash in a batch that the service accepted is answered, `unavailable` included; a batch is never dropped silently. A hash the service could not read is simply absent, and the host offers it again when its lease on the batch ends.
- 204, and only 204, means the host took the verdicts. 409 means the host no longer holds that batch (its lease ended); the service does not retry it. Any other status, a 200 included, is a failure and the service backs off.
- **A batch answered wholly `unavailable` is counted as degraded, and the service backs off exactly as for a failure.** Without that, a hash source that is down and a host that offers its hashes again at once would make a storm of requests against the source. Pacing the re-offer is the host's to build too: the contract asks a host to wait before it offers an `unavailable` hash again.

## What a host must do with silence

A host that has had no verdict for a hash, for whatever reason, holds the object and serves nothing. An allow is only ever a `no-known-match` verdict with `action: allow`.

## Versioning

`v` is 1 in both directions and the path carries `/v1/`. A body with any other `v` is refused as a contract break; the service logs a fixed reason, polls again after backoff, and answers nothing. A change to either shape is a new version, served alongside the old one until no host uses it.

## Not in version 1

- A route that lists stored hashes, which the re-scan sweep needs to ask again about what is already stored.
- A host discovery source: the service reads its hosts from its own configuration file until the tenant descriptor carries a verdict-channel endpoint.
- A producer-side age metric: it is the host's to export, because only the host knows how long its oldest hash has waited.

## What persists across a restart

The audit trail, which is an append-only file. It is refused if it already exists and is readable by group or others, and a torn last line is closed off before the next record is written. Lines written in the same turn share one append and one sync. The verdict cache is in memory: after a restart a hash is asked about again, which costs one lookup and changes no answer, because the hash source remains the authority. Whatever the host had queued is the host's to keep.
