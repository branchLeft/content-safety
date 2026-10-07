# content-safety

The safety service for the branchLeft Ghost platform. It checks uploaded media against known-abuse hash lists (Arachnid Shield) before publication. It is designed to be reusable by other organisations later, so it carries no Ghost-specific assumptions.

**Status: the service core, tested locally, not deployed.** No credential exists yet, so it is built against the published API specification and a local stub.

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
