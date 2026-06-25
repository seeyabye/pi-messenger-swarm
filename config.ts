/**
 * Pi Messenger - Configuration
 *
 * Priority (highest to lowest):
 * 1. Project: .pi/pi-messenger.json
 * 2. Extension-specific: ~/.pi/agent/pi-messenger.json
 * 3. Main settings: ~/.pi/agent/settings.json → "messenger" key
 * 4. Defaults
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

export interface MessengerConfig {
  autoRegister: boolean;
  autoRegisterPaths: string[];
  scopeToFolder: boolean;
  contextMode: 'full' | 'minimal' | 'none';
  registrationContext: boolean;
  replyHint: boolean;
  senderDetailsOnFirstContact: boolean;
  nameTheme: string;
  nameWords?: { adjectives: string[]; nouns: string[] };
  feedRetention: number;
  stuckThreshold: number;
  stuckNotify: boolean;
  autoStatus: boolean;
  autoOverlay: boolean;
  swarmEventsInFeed: boolean;
  maxConcurrentSpawns: number;
}

const DEFAULT_CONFIG: MessengerConfig = {
  autoRegister: false,
  autoRegisterPaths: [],
  scopeToFolder: true, // Default to project-scoped isolation for swarm safety
  contextMode: 'full',
  registrationContext: true,
  replyHint: true,
  senderDetailsOnFirstContact: true,
  nameTheme: 'default',
  feedRetention: 50,
  stuckThreshold: 900,
  stuckNotify: true,
  autoStatus: true,
  autoOverlay: true,
  swarmEventsInFeed: true,
  maxConcurrentSpawns: 3,
};

function readJsonFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function expandHome(p: string): string {
  if (p.startsWith('~/')) {
    return join(getAgentDir(), '..', p.slice(2));
  }
  return p;
}

export function matchesAutoRegisterPath(cwd: string, paths: string[]): boolean {
  const normalizedCwd = cwd.replace(/\/+$/, ''); // Remove trailing slashes

  for (const pattern of paths) {
    const expanded = expandHome(pattern).replace(/\/+$/, '');

    // Simple glob support: trailing /* matches any subdirectory
    if (expanded.endsWith('/*')) {
      const base = expanded.slice(0, -2);
      if (normalizedCwd === base || normalizedCwd.startsWith(base + '/')) {
        return true;
      }
    } else if (expanded.endsWith('*')) {
      // Prefix match: /path/prefix* matches /path/prefix-anything
      const prefix = expanded.slice(0, -1);
      if (normalizedCwd.startsWith(prefix)) {
        return true;
      }
    } else {
      // Exact match
      if (normalizedCwd === expanded) {
        return true;
      }
    }
  }

  return false;
}

export function saveAutoRegisterPaths(paths: string[]): void {
  const configPath = join(getAgentDir(), 'pi-messenger.json');
  let existing: Record<string, unknown> = {};

  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      // Start fresh if malformed
    }
  }

  existing.autoRegisterPaths = paths;

  const dir = getAgentDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(existing, null, 2));
}

export function getAutoRegisterPaths(): string[] {
  const configPath = join(getAgentDir(), 'pi-messenger.json');
  if (!existsSync(configPath)) return [];

  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    return Array.isArray(config.autoRegisterPaths) ? config.autoRegisterPaths : [];
  } catch {
    return [];
  }
}

export function loadConfig(cwd: string): MessengerConfig {
  const projectPath = join(cwd, '.pi', 'pi-messenger.json');
  const extensionGlobalPath = join(getAgentDir(), 'pi-messenger.json');
  const mainSettingsPath = join(getAgentDir(), 'settings.json');

  // Load from main settings.json (lowest priority of the three sources)
  let settingsConfig: Partial<MessengerConfig> = {};
  const mainSettings = readJsonFile(mainSettingsPath);
  if (
    mainSettings &&
    typeof mainSettings.messenger === 'object' &&
    mainSettings.messenger !== null
  ) {
    settingsConfig = mainSettings.messenger as Partial<MessengerConfig>;
  }

  // Load extension-specific global config
  const extensionConfig = readJsonFile(extensionGlobalPath) as Partial<MessengerConfig> | null;

  // Load project config (highest priority)
  const projectConfig = readJsonFile(projectPath) as Partial<MessengerConfig> | null;

  const merged = {
    ...DEFAULT_CONFIG,
    ...settingsConfig,
    ...(extensionConfig ?? {}),
    ...(projectConfig ?? {}),
  };

  const nameWords = (merged as Record<string, unknown>).nameWords as
    | { adjectives: string[]; nouns: string[] }
    | undefined;

  const sharedFields = {
    nameTheme: typeof merged.nameTheme === 'string' ? merged.nameTheme : DEFAULT_CONFIG.nameTheme,
    nameWords:
      nameWords && Array.isArray(nameWords.adjectives) && Array.isArray(nameWords.nouns)
        ? nameWords
        : undefined,
    feedRetention:
      typeof merged.feedRetention === 'number'
        ? merged.feedRetention
        : DEFAULT_CONFIG.feedRetention,
    stuckThreshold:
      typeof merged.stuckThreshold === 'number'
        ? merged.stuckThreshold
        : DEFAULT_CONFIG.stuckThreshold,
    stuckNotify: merged.stuckNotify !== false,
    autoStatus: merged.autoStatus !== false,
    autoOverlay: merged.autoOverlay !== false,
    swarmEventsInFeed: (merged as Record<string, unknown>).swarmEventsInFeed !== false,
    maxConcurrentSpawns:
      typeof merged.maxConcurrentSpawns === 'number' && merged.maxConcurrentSpawns > 0
        ? merged.maxConcurrentSpawns
        : DEFAULT_CONFIG.maxConcurrentSpawns,
  };

  if (merged.contextMode === 'none') {
    return {
      autoRegister: merged.autoRegister === true,
      autoRegisterPaths: Array.isArray(merged.autoRegisterPaths) ? merged.autoRegisterPaths : [],
      scopeToFolder: merged.scopeToFolder === true,
      contextMode: 'none',
      registrationContext: false,
      replyHint: false,
      senderDetailsOnFirstContact: false,
      ...sharedFields,
    };
  }

  if (merged.contextMode === 'minimal') {
    return {
      autoRegister: merged.autoRegister === true,
      autoRegisterPaths: Array.isArray(merged.autoRegisterPaths) ? merged.autoRegisterPaths : [],
      scopeToFolder: merged.scopeToFolder === true,
      contextMode: 'minimal',
      registrationContext: false,
      replyHint: true,
      senderDetailsOnFirstContact: false,
      ...sharedFields,
    };
  }

  return {
    autoRegister: merged.autoRegister === true,
    autoRegisterPaths: Array.isArray(merged.autoRegisterPaths) ? merged.autoRegisterPaths : [],
    scopeToFolder: merged.scopeToFolder === true,
    contextMode: 'full',
    registrationContext: merged.registrationContext !== false,
    replyHint: merged.replyHint !== false,
    senderDetailsOnFirstContact: merged.senderDetailsOnFirstContact !== false,
    ...sharedFields,
  };
}

/**
 * Mtime-aware cached config loader.
 *
 * `loadConfig` reads the project's `.pi/pi-messenger.json` (the highest-priority
 * source and the only one users edit at runtime) on every call, which is too
 * costly to do per HTTP request. `configForCwd` (in harness/server.ts) caches
 * the result per cwd, but previously cached it **indefinitely** — so editing
 * `.pi/pi-messenger.json` (e.g. raising `maxConcurrentSpawns`) had no effect
 * until a full `--restart` cleared the cache. That forced a confusing
 * stop/start of the shared harness, which kills any running spawned agents.
 *
 * `loadConfigCached` keeps the per-cwd cache but re-reads when the project
 * config file's mtime changes. The lower-priority global sources
 * (`~/.pi/agent/pi-messenger.json`, `settings.json`) are read fresh on every
 * cache miss; they change rarely enough that not invalidating on their mtime
 * is an acceptable tradeoff (a `--restart` still forces a full reload).
 */
interface CachedConfig {
  config: MessengerConfig;
  /** mtime (ms) of the project config file at cache time, or -1 if absent. */
  projectMtimeMs: number;
}

const configCacheByCwd = new Map<string, CachedConfig>();

function projectConfigMtimeMs(cwd: string): number {
  try {
    return statSync(join(cwd, '.pi', 'pi-messenger.json')).mtimeMs;
  } catch {
    return -1;
  }
}

/**
 * Returns the cached config for `cwd`, re-reading from disk when the project
 * config file has been modified (or created/deleted) since the last read.
 *
 * Exported for use by the harness server; also unit-tested directly. Pass
 * `forceRefresh` to bypass the cache (equivalent to what `/restart` does by
 * calling `clearConfigCache`).
 */
export function loadConfigCached(cwd: string, forceRefresh = false): MessengerConfig {
  const currentMtime = projectConfigMtimeMs(cwd);
  const cached = configCacheByCwd.get(cwd);
  if (!forceRefresh && cached && cached.projectMtimeMs === currentMtime) {
    return cached.config;
  }
  const config = loadConfig(cwd);
  configCacheByCwd.set(cwd, { config, projectMtimeMs: currentMtime });
  return config;
}

/** Clear the config cache (used by the `/restart` endpoint). */
export function clearConfigCache(): void {
  configCacheByCwd.clear();
}
