import { AuditFileError } from './audit-file.js';
import { ConfigError, loadConfig } from './config.js';
import { SecretFileError } from './credential.js';
import type { LogFields, Logger } from './host-channel.js';
import { startService, type StartDeps } from './service-runner.js';

export const CONFIG_ENV = 'SAFETY_SERVICE_CONFIG';

export interface MainIo {
  /** Receives one JSON line per event. */
  readonly write: (line: string) => void;
  /** Resolves when the process has been asked to stop. */
  readonly waitForStop: () => Promise<void>;
  readonly now?: () => Date;
  readonly deps?: Pick<StartDeps, 'fetch' | 'sleep'>;
}

/** Exit codes: 0 stopped cleanly, 1 refused to start, 2 no configuration named. */
export async function runMain(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: MainIo
): Promise<number> {
  const now = io.now ?? (() => new Date());
  const log: Logger = (event: string, fields: LogFields) => {
    io.write(JSON.stringify({ at: now().toISOString(), event, ...fields }));
  };

  const configPath = configPathFrom(argv, env);
  if (configPath === undefined) {
    log('refused-to-start', { reason: `name a configuration file with --config or ${CONFIG_ENV}` });
    return 2;
  }

  let running: Awaited<ReturnType<typeof startService>>;
  let graceMs: number;
  try {
    const config = await loadConfig(configPath);
    graceMs = config.shutdownGraceMs;
    running = await startService(config, { log, ...io.deps });
  } catch (error) {
    // Only errors this service builds carry a message written to be shown:
    // anything else is named by its class so no foreign text is logged.
    const known =
      error instanceof ConfigError || error instanceof SecretFileError || error instanceof AuditFileError;
    log('refused-to-start', { reason: known ? error.message : errorClass(error) });
    return 1;
  }

  log('started', { hosts: running.hosts });
  await io.waitForStop();
  log('stopping', { hosts: running.hosts });
  await Promise.race([running.stop(), new Promise<void>((resolve) => setTimeout(resolve, graceMs).unref())]);
  log('stopped', {});
  return 0;
}

function configPathFrom(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>
): string | undefined {
  const flag = argv.indexOf('--config');
  const fromFlag = flag === -1 ? undefined : argv[flag + 1];
  const path = fromFlag ?? env[CONFIG_ENV];
  return path === undefined || path === '' ? undefined : path;
}

function errorClass(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown error';
}
