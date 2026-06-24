/**
 * Pure messenger data-directory resolution. Extracted from harness/server.ts
 * so it can be unit-tested without importing the server (which starts an HTTP
 * server as a top-level side effect on import).
 *
 * Resolution priority for the base data directory:
 *   1. overrideBase  — per-request explicit override (the x-messenger-dir
 *      header, sent by the CLI when the user sets PI_MESSENGER_DIR). Highest.
 *   2. PI_MESSENGER_DIR env — ONLY when no cwd is provided, i.e. for the
 *      server's startup dirs. Per-request calls pass a cwd, so the server
 *      env (which the extension pins to its own project) cannot leak into
 *      other projects' requests (the bug fixed by 3dfb30d).
 *   3. PI_MESSENGER_GLOBAL=1 → shared homedir dir.
 *   4. <cwd>/.pi/messenger (default, project-scoped).
 */
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { normalizeCwd } from '../store/shared.js';
import type { Dirs } from '../lib.js';

export interface ResolveMessengerDirsOptions {
  /** Caller cwd. When omitted, resolves the server's startup dirs. */
  cwd?: string;
  /** Per-request override from the x-messenger-dir header. */
  overrideBase?: string;
  /** Env source (defaults to process.env) for test injection. */
  env?: Record<string, string | undefined>;
}

export function resolveMessengerDirs(options: ResolveMessengerDirsOptions = {}): Dirs {
  const { cwd, overrideBase } = options;
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const effectiveCwd = cwd ?? env.PI_MESSENGER_CWD ?? process.cwd();
  const baseDir =
    overrideBase ||
    (cwd ? undefined : env.PI_MESSENGER_DIR) ||
    (env.PI_MESSENGER_GLOBAL === '1'
      ? join(getAgentDir(), 'messenger')
      : join(normalizeCwd(effectiveCwd), '.pi/messenger'));
  return { base: baseDir, registry: join(baseDir, 'registry') };
}
