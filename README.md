# content-safety

The safety service for the branchLeft Ghost platform. It checks uploaded media against known-abuse hash lists (Arachnid Shield) before publication. It is designed to be reusable by other organisations later, so it carries no Ghost-specific assumptions.

**Status: the service core and its transport, tested locally against stubs, not deployed.** This repository holds no credential and no test touches a live service. The service reads its credential from a file on the host that runs it.

## What is here

| Module | Role |
|---|---|
| `src/contract.ts` | The interfaces: `Check`, `Verdict`, `Policy`, `Decision`, `VerdictCache`, `AuditSink`, `PdqLookup`. |
| `src/pdq-hash.ts` | The only way to make a `PdqHash`: the canonical base64 of exactly 32 bytes. |
| `src/arachnid-client.ts` | `POST /v1/pdq` with a body of hashes. No other endpoint has a code path. |
| `src/pdq-known-material-check.ts` | The blocking media check: cache first, one batched lookup, a timeout after which every waiting hash is `unavailable`. |
| `src/verdict-cache.ts` | Positives kept for ever, negatives for a bounded lifetime of at most seven days (`MAX_NEGATIVE_TTL_MS`, refused above it), `unavailable` never. A size bound (`maxEntries`) sweeps expired negatives, then evicts the oldest negative; a positive is never evicted. |
| `src/policy.ts` | `decide(verdict, context)`: the two tiers, and the demo-versus-tenant split for tier two only. |
| `src/audit.ts` | Digests, verdicts and decisions. Never bytes, never a thumbnail. |
| `src/safety-service.ts` | Hashes in, one decision per hash out, each with `audited: true` or `false`. |
| `src/deadline.ts` | The bound on every cache read and write and every audit write. |
| `src/channel-contract.ts` | The wire contract's constants, the strict reader of a poll answer and the builder of a verdicts body. See [docs/verdict-channel.md](docs/verdict-channel.md). |
| `src/host-channel.ts` | One host's channel: poll, assess, return verdicts, back off, stop. Dials; never listens. |
| `src/request-signer.ts` | Ed25519 request signing, so a host can tell this service from anyone else who reaches it. |
| `src/credential.ts` | Reads a secret from an owner-only file into a value that logs and serialises as a placeholder. |
| `src/config.ts` | The service's configuration file: strict, with no default that names a file, host or address. |
| `src/audit-file.ts` | The audit trail as an append-only, synced, owner-only file. |
| `src/service-runner.ts`, `src/main.ts`, `src/bin.ts` | The process: read both secrets, open the audit file, dial every host, stop on a signal. |

## Running it

```sh
npm run build
SAFETY_SERVICE_CONFIG=CONFIG_FILE_PATH npm start
```

The configuration names four files and the hosts to dial:

```json
{
  "arachnid": { "baseUrl": "https://HASH_SOURCE_ORIGIN", "credentialFile": "CREDENTIAL_FILE_PATH" },
  "channel": { "signingKeyFile": "SIGNING_KEY_FILE_PATH" },
  "cache": { "negativeTtlMs": 86400000 },
  "audit": { "file": "AUDIT_FILE_PATH" },
  "hosts": [
    { "id": "HOST_ID", "kind": "demo", "safety": { "near": true, "exact": true }, "endpoint": "https://HOST_ORIGIN" }
  ]
}
```

- The credential file holds the complete `Authorization` header value on one line, because the form the supplier takes is not stated in its published specification. It is read once, never from the environment. It must be a regular file: a symbolic link is refused, and so is a file readable by anyone but its owner (checked on the one descriptor the file is read from).
- The signing key file holds the base64 of a 32-byte Ed25519 seed. Hosts hold only the public key.
- The process refuses to start, with exit code 1 and a one-line reason that never quotes a file's content, when a file is missing, empty or open to others, or a setting is absent or unknown.
- Output is one JSON line per event, carrying fixed names and counts only.

## What a verdict leads to

| Verdict | Decision | Demo | Tenant |
|---|---|---|---|
| `exact` + `csam` | tier two, irreversible | withhold, seal, start the reporting clock, page, kill the slot quietly | the same, but the site keeps serving |
| `near` + `csam` | tier one | withhold and freeze | withhold and freeze |
| any `harmful-abusive-material` | tier one | withhold and freeze | withhold and freeze |
| `test` | as the match type selects, marked as a control | | |
| `no-known-match` | allow | | |
| `unavailable` | hold | | |

A context whose safety axis is not fully on, or whose estate is unknown, is held. An allow that cannot be audited within its budget is held; a refusal or a hold that cannot be audited stands, with `audited: false` so the caller can raise it. A cache read past its budget is a miss, and a verdict about a different hash than the one asked is no verdict.

## License

Source-available under the PolyForm Shield License 1.0.0. See [LICENSE](LICENSE).
