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
const DEFAULT_CONFIG = {
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
function readJsonFile(path) {
    if (!existsSync(path))
        return null;
    try {
        return JSON.parse(readFileSync(path, 'utf-8'));
    }
    catch {
        return null;
    }
}
function expandHome(p) {
    if (p.startsWith('~/')) {
        return join(getAgentDir(), '..', p.slice(2));
    }
    return p;
}
export function matchesAutoRegisterPath(cwd, paths) {
    const normalizedCwd = cwd.replace(/\/+$/, ''); // Remove trailing slashes
    for (const pattern of paths) {
        const expanded = expandHome(pattern).replace(/\/+$/, '');
        // Simple glob support: trailing /* matches any subdirectory
        if (expanded.endsWith('/*')) {
            const base = expanded.slice(0, -2);
            if (normalizedCwd === base || normalizedCwd.startsWith(base + '/')) {
                return true;
            }
        }
        else if (expanded.endsWith('*')) {
            // Prefix match: /path/prefix* matches /path/prefix-anything
            const prefix = expanded.slice(0, -1);
            if (normalizedCwd.startsWith(prefix)) {
                return true;
            }
        }
        else {
            // Exact match
            if (normalizedCwd === expanded) {
                return true;
            }
        }
    }
    return false;
}
export function saveAutoRegisterPaths(paths) {
    const configPath = join(getAgentDir(), 'pi-messenger.json');
    let existing = {};
    if (existsSync(configPath)) {
        try {
            existing = JSON.parse(readFileSync(configPath, 'utf-8'));
        }
        catch {
            // Start fresh if malformed
        }
    }
    existing.autoRegisterPaths = paths;
    const dir = getAgentDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(configPath, JSON.stringify(existing, null, 2));
}
export function getAutoRegisterPaths() {
    const configPath = join(getAgentDir(), 'pi-messenger.json');
    if (!existsSync(configPath))
        return [];
    try {
        const config = JSON.parse(readFileSync(configPath, 'utf-8'));
        return Array.isArray(config.autoRegisterPaths) ? config.autoRegisterPaths : [];
    }
    catch {
        return [];
    }
}
export function loadConfig(cwd) {
    const projectPath = join(cwd, '.pi', 'pi-messenger.json');
    const extensionGlobalPath = join(getAgentDir(), 'pi-messenger.json');
    const mainSettingsPath = join(getAgentDir(), 'settings.json');
    // Load from main settings.json (lowest priority of the three sources)
    let settingsConfig = {};
    const mainSettings = readJsonFile(mainSettingsPath);
    if (mainSettings &&
        typeof mainSettings.messenger === 'object' &&
        mainSettings.messenger !== null) {
        settingsConfig = mainSettings.messenger;
    }
    // Load extension-specific global config
    const extensionConfig = readJsonFile(extensionGlobalPath);
    // Load project config (highest priority)
    const projectConfig = readJsonFile(projectPath);
    const merged = {
        ...DEFAULT_CONFIG,
        ...settingsConfig,
        ...(extensionConfig ?? {}),
        ...(projectConfig ?? {}),
    };
    const nameWords = merged.nameWords;
    const sharedFields = {
        nameTheme: typeof merged.nameTheme === 'string' ? merged.nameTheme : DEFAULT_CONFIG.nameTheme,
        nameWords: nameWords && Array.isArray(nameWords.adjectives) && Array.isArray(nameWords.nouns)
            ? nameWords
            : undefined,
        feedRetention: typeof merged.feedRetention === 'number'
            ? merged.feedRetention
            : DEFAULT_CONFIG.feedRetention,
        stuckThreshold: typeof merged.stuckThreshold === 'number'
            ? merged.stuckThreshold
            : DEFAULT_CONFIG.stuckThreshold,
        stuckNotify: merged.stuckNotify !== false,
        autoStatus: merged.autoStatus !== false,
        autoOverlay: merged.autoOverlay !== false,
        swarmEventsInFeed: merged.swarmEventsInFeed !== false,
        maxConcurrentSpawns: typeof merged.maxConcurrentSpawns === 'number' && merged.maxConcurrentSpawns > 0
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
const configCacheByCwd = new Map();
function projectConfigMtimeMs(cwd) {
    try {
        return statSync(join(cwd, '.pi', 'pi-messenger.json')).mtimeMs;
    }
    catch {
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
export function loadConfigCached(cwd, forceRefresh = false) {
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
export function clearConfigCache() {
    configCacheByCwd.clear();
}
