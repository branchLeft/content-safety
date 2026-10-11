import { ArachnidPdqClient, type FetchLike } from './arachnid-client.js';
import { openAuditFile } from './audit-file.js';
import { JsonLinesAuditSink } from './audit.js';
import type { ServiceConfig } from './config.js';
import { readSecretFile } from './credential.js';
import { HostChannel, type Logger } from './host-channel.js';
import { PdqKnownMaterialCheck } from './pdq-known-material-check.js';
import { EstatePolicy } from './policy.js';
import { RequestSigner } from './request-signer.js';
import { SafetyService } from './safety-service.js';
import { InMemoryVerdictCache } from './verdict-cache.js';

export interface StartDeps {
  readonly log: Logger;
  /** Used for both the hash source and the hosts; a test passes a recorder. */
  readonly fetch?: FetchLike;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface RunningService {
  readonly hosts: number;
  /** Stops every channel, waits for answers in flight, then closes the audit file. */
  stop(): Promise<void>;
}

/**
 * Reads both secrets and opens the audit file before dialling anything, so
 * a missing credential stops the process before it asks anyone for anything.
 */
export async function startService(config: ServiceConfig, deps: StartDeps): Promise<RunningService> {
  const credential = await readSecretFile(config.arachnid.credentialFile, 'hash source credential');
  const signingSeed = await readSecretFile(config.channel.signingKeyFile, 'request signing key');
  const signer = new RequestSigner(signingSeed);
  const auditFile = await openAuditFile(config.audit.file);

  const client = new ArachnidPdqClient({
    baseUrl: config.arachnid.baseUrl,
    authorization: () => credential.reveal(),
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
  });
  const cache = new InMemoryVerdictCache({
    negativeTtlMs: config.cache.negativeTtlMs,
    ...(config.cache.maxEntries === undefined ? {} : { maxEntries: config.cache.maxEntries }),
  });
  const check = new PdqKnownMaterialCheck({
    lookup: client,
    cache,
    timeoutMs: config.arachnid.timeoutMs,
    ...(config.arachnid.maxBatchSize === undefined ? {} : { maxBatchSize: config.arachnid.maxBatchSize }),
  });
  const service = new SafetyService({
    check,
    policy: new EstatePolicy(),
    audit: new JsonLinesAuditSink((line) => auditFile.write(line)),
  });

  const channels = config.hosts.map(
    (host) =>
      new HostChannel({
        host,
        assess: (hashes, context) => service.assess(hashes, context),
        signer,
        log: deps.log,
        pollTimeoutMs: config.channel.pollTimeoutMs,
        postTimeoutMs: config.channel.postTimeoutMs,
        minPollGapMs: config.channel.minPollGapMs,
        backoffBaseMs: config.channel.backoffBaseMs,
        backoffMaxMs: config.channel.backoffMaxMs,
        ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
        ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
      })
  );
  for (const channel of channels) channel.start();

  let stopped: Promise<void> | undefined;
  return {
    hosts: channels.length,
    stop(): Promise<void> {
      stopped ??= Promise.all(channels.map((channel) => channel.stop())).then(() => auditFile.close());
      return stopped;
    },
  };
}
