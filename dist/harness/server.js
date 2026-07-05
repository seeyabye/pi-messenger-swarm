/**
 * Pi Messenger Harness Server
 *
 * Long-lived HTTP server for action dispatch.
 * Models call `pi-messenger-swarm join` / `pi-messenger-swarm task claim task-1` etc.
 *
 * Multi-agent aware: each request carries an x-caller-pid header
 * (the PID of the calling agent's pi process, discovered by the CLI
 * by walking its own process tree).  The server resolves the correct
 * per-agent state from disk before dispatching.
 *
 * Endpoints (bind 127.0.0.1:9877 by default; override with $PI_MESSENGER_PORT):
 *   POST /action   body = JSON action params (must include `action` field)
 *                  Headers: x-caller-pid, x-messenger-channel
 *                  Response: { ok: true, result: {...} } | { ok: false, error: string }
 *   GET  /health   { ok: true, uptime, agents }
 *   POST /quit     graceful shutdown
 */
import { createServer } from 'node:http';
import { join } from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isProcessAlive } from '../lib.js';
import { loadConfigCached, clearConfigCache } from '../config.js';
import { executeAction } from '../router.js';
import { normalizeChannelId, ensureDefaultNamedChannels, ensureSessionChannel, getChannelsDir, patchChannelSessionId, } from '../channel.js';
import { ensureDirSync, getGitBranch, normalizeCwd } from '../store/shared.js';
import { resolveMessengerDirs } from './paths.js';
import { stopAllSpawned, forceKillAllSpawned, persistRuntimes, restoreRuntimes, reconcileAndRestoreOrphans, clearPersistedRuntimes, getRunningSpawnCount, } from '../swarm/spawn.js';
// How often the running-runtimes snapshot is persisted for crash recovery.
// Cheap (a small JSON write) and bounds the crash-recovery staleness window.
const RUNTIME_PERSIST_INTERVAL_MS = 15_000;
function getMessengerDirs(cwd, overrideBase) {
    // Delegates to the pure, unit-tested resolveMessengerDirs() in paths.ts.
    // See that module for the resolution-priority rationale (overrideBase >
    // startup-only PI_MESSENGER_DIR > global > cwd-scoped).
    return resolveMessengerDirs({ cwd, overrideBase });
}
// Bootstrap dirs from the server's startup cwd for health checks and
// initial setup. Per-request dirs are resolved in the action handler
// using the requesting agent's cwd from registration files.
const startupDirs = getMessengerDirs();
// Ensure channel / registry dirs exist for the startup project
ensureDirSync(startupDirs.registry);
ensureDirSync(getChannelsDir(startupDirs));
ensureDefaultNamedChannels(startupDirs);
// Restore spawned agent runtimes from a previous server instance.
// If the harness was restarted (version mismatch, crash, etc.), spawned
// agents survive because they're independent processes — we just need to
// pick up tracking them again.
//
// Two restore paths:
// 1. Clean restart: spawn-runtimes.json was written by persistRuntimes()
//    before the old server exited.
// 2. Crash recovery: no spawn-runtimes.json exists, but the event log
//    still shows agents with status 'running'. reconcileAndRestoreOrphans()
//    scans the log and reconnects to live PIDs.
let restoredCount = restoreRuntimes(startupDirs.base);
if (restoredCount > 0) {
    serverLog(`restored ${restoredCount} spawned agent runtime(s) from previous server instance`);
}
// Always clear the persisted snapshot after restore (even when 0 were alive):
// restoreRuntimes already tombstoned any dead entries, so leaving the file
// would only cause the next start to re-process the same dead records
// (harmless thanks to the don't-override-terminal guard, but redundant).
clearPersistedRuntimes(startupDirs.base);
const orphanCount = reconcileAndRestoreOrphans(startupDirs.base);
if (orphanCount > 0) {
    serverLog(`reconnected ${orphanCount} orphaned agent(s) from event log`);
}
// Periodically persist running runtimes so a harness CRASH (no graceful
// shutdown) still leaves a fresh spawn-runtimes.json for the next instance.
// persistRuntimes writes ALL in-memory runtimes — across every project this
// harness serves — to a single file, so the next restoreRuntimes() recovers
// every project's agents (and finalizeDeadPersistedRuntime tombstones any
// that exited in the meantime). Without this, a crash reattached only the
// startup project (reconcileAndRestoreOrphans scans startupDirs alone) and
// left other projects' event logs stuck at status 'running'.
setInterval(() => {
    if (getRunningSpawnCount() > 0) {
        persistRuntimes(startupDirs.base);
    }
}, RUNTIME_PERSIST_INTERVAL_MS).unref();
// Per-request directory cache: cwd → Dirs (avoids recomputing on every request).
const dirsCache = new Map();
function dirsForCwd(cwd, overrideBase) {
    // Cache key includes overrideBase so two callers from the same cwd but with
    // different explicit PI_MESSENGER_DIR overrides don't share a cached entry.
    const cacheKey = overrideBase ? `${cwd}\0${overrideBase}` : cwd;
    const cached = dirsCache.get(cacheKey);
    if (cached)
        return cached;
    const dirs = getMessengerDirs(cwd, overrideBase);
    dirsCache.set(cacheKey, dirs);
    // Ensure dirs exist for this project too
    ensureDirSync(dirs.registry);
    ensureDirSync(getChannelsDir(dirs));
    ensureDefaultNamedChannels(dirs);
    return dirs;
}
// Per-request config cache: cwd → config. Delegates to loadConfigCached(),
// which re-reads `.pi/pi-messenger.json` when its mtime changes — so editing the
// project config (e.g. raising maxConcurrentSpawns) takes effect without a
// server restart. A full cache clear is still performed by /restart.
function configForCwd(cwd) {
    return loadConfigCached(cwd);
}
function routerConfigForCwd(cwd) {
    const config = configForCwd(cwd);
    return {
        stuckThreshold: config.stuckThreshold,
        swarmEventsInFeed: config.swarmEventsInFeed,
        nameTheme: { theme: config.nameTheme, customWords: config.nameWords },
        feedRetention: config.feedRetention,
        maxConcurrentSpawns: config.maxConcurrentSpawns,
    };
}
function readRegistrations(dirs, projectCwd) {
    try {
        const files = fs.readdirSync(dirs.registry).filter((f) => f.endsWith('.json'));
        const regs = files
            .map((f) => {
            try {
                return JSON.parse(fs.readFileSync(join(dirs.registry, f), 'utf-8'));
            }
            catch {
                return null;
            }
        })
            .filter((r) => r !== null);
        // Filter out stale cross-project registrations: a registration whose
        // cwd doesn't belong to this project was written here due to a previous
        // cwd resolution bug. Skip it so the agent gets a fresh identity.
        if (projectCwd) {
            const normalized = normalizeCwd(projectCwd);
            return regs.filter((r) => !r.cwd || normalizeCwd(r.cwd) === normalized);
        }
        return regs;
    }
    catch {
        return [];
    }
}
/**
 * Build a MessengerState for the requesting agent.
 *
 * Identity resolution strategy (environment-based, no PID hacks):
 * 1. If x-agent-name header is provided, find the registration whose
 *    `name` field matches. This is the robust path — spawned subagents
 *    carry PI_AGENT_NAME set by the parent, and the CLI forwards it.
 * 2. If x-caller-pid header is provided, find the registration whose
 *    `pid` field matches. This is the legacy path for pi sessions that
 *    don't set PI_AGENT_NAME (human terminal, CI).
 * 3. If no identity hint (or no registrations), fall back to:
 *    a. If only one registration on disk → use it (single-agent convenience)
 *    b. If multiple → pick the most recently active by file mtime
 * 4. If no registrations at all, return an unregistered state.
 */
function resolveAgentState(dirs, callerPid, agentName, channelHint, requestSessionId, projectCwd) {
    // Default resolvedCwd to the project's cwd (derived from dirs.base or
    // the explicit projectCwd parameter). Fall back to PI_MESSENGER_CWD only
    // if no project context is available.
    let resolvedCwd = projectCwd
        ? normalizeCwd(projectCwd)
        : normalizeCwd(process.env.PI_MESSENGER_CWD ?? process.cwd());
    const gitBranch = getGitBranch(resolvedCwd);
    let registered = false;
    let resolvedName = '';
    let currentChannel = '';
    let sessionChannel = '';
    let joinedChannels = [];
    let sessionIdFromDisk = '';
    const regs = readRegistrations(dirs, projectCwd);
    // Strategy 1: match by agent name (robust — env-var based)
    if (agentName) {
        const match = regs.find((r) => r.name === agentName);
        if (match) {
            resolvedName = match.name;
            sessionIdFromDisk = match.sessionId || '';
            currentChannel = match.currentChannel || '';
            sessionChannel = match.sessionChannel || currentChannel;
            joinedChannels = match.joinedChannels || [];
            registered = true;
        }
        else {
            // No registration on disk yet (e.g., subagent's join hasn't
            // completed). Still honor the explicit name so the agent's
            // identity is preserved — we only set the name, not registered=true,
            // so that executeJoin takes the fresh-registration path which
            // properly handles the channelHint / preexistingChannel flow.
            // Non-join actions will get a not-registered error, which is
            // correct — the subagent should join first.
            resolvedName = agentName;
            registered = false;
        }
    }
    // Strategy 2: match by caller PID (legacy fallback)
    // Skip if an explicit agent name was provided but not found —
    // we'd rather preserve the explicit name than match by PID.
    if (!registered && !agentName && callerPid) {
        const match = regs.find((r) => r.pid === callerPid);
        if (match) {
            resolvedName = match.name;
            sessionIdFromDisk = match.sessionId || '';
            currentChannel = match.currentChannel || '';
            sessionChannel = match.sessionChannel || currentChannel;
            joinedChannels = match.joinedChannels || [];
            registered = true;
        }
    }
    // Strategy 3: fallback — single agent or most recently active
    // Skip if an explicit agent name was provided but not found.
    if (!registered && !agentName && regs.length > 0) {
        if (regs.length === 1) {
            const reg = regs[0];
            resolvedName = reg.name;
            sessionIdFromDisk = reg.sessionId || '';
            currentChannel = reg.currentChannel || '';
            sessionChannel = reg.sessionChannel || currentChannel;
            joinedChannels = reg.joinedChannels || [];
            registered = true;
        }
        else {
            // Multiple agents, no identity hint — pick most recently active by
            // mtime, but skip registrations whose owning pi process is dead so a
            // stale session from a previous run isn't adopted (which would route
            // this request onto that dead session's channel).
            let best = null;
            for (const reg of regs) {
                if (reg.pid && !isProcessAlive(reg.pid))
                    continue;
                let mtime = 0;
                try {
                    mtime = fs.statSync(join(dirs.registry, `${reg.name}.json`)).mtimeMs;
                }
                catch {
                    continue;
                }
                if (!best || mtime > best.mtime) {
                    best = { name: reg.name, mtime };
                }
            }
            if (best) {
                const reg = regs.find((r) => r.name === best.name);
                if (reg) {
                    resolvedName = reg.name;
                    sessionIdFromDisk = reg.sessionId || '';
                    currentChannel = reg.currentChannel || '';
                    sessionChannel = reg.sessionChannel || currentChannel;
                    joinedChannels = reg.joinedChannels || [];
                    registered = true;
                }
            }
        }
    }
    // Session mismatch: the request's x-session-id differs from the
    // registration's sessionId. This happens when:
    //   1. The session-id file was overwritten by a different pi process
    //   2. The agent resumed in a new pi session after a crash/disconnect
    //   3. Multiple pi sessions share the same project directory
    //
    // We must NOT wipe currentChannel or joinedChannels — these reflect the
    // agent's actual working state (they explicitly joined those channels).
    // Doing so causes the exact failure observed in the wild: coordinator
    // joins #loud-moon, spawns agents, then after a harness restart its
    // feed/task.list/task.show calls resolve to the wrong channel because
    // the session mismatch wiped the channel context.
    //
    // We only reset sessionChannel — the per-session channel is tied to the
    // old session and a new one will be created for the current session if
    // needed. But if the agent's currentChannel matches the old sessionChannel,
    // update it to the new session's channel when it's created below.
    if (registered &&
        requestSessionId &&
        sessionIdFromDisk &&
        sessionIdFromDisk !== requestSessionId) {
        // Track if currentChannel was the old sessionChannel so we can update it
        const currentIsSessionChannel = currentChannel === sessionChannel;
        sessionChannel = '';
        // If the agent was on its session channel, clear currentChannel too
        // so a new session channel can be assigned below.
        if (currentIsSessionChannel)
            currentChannel = '';
        // Keep joinedChannels and name + registered so we reuse the same identity.
    }
    // Override channel from request header if provided.
    //
    // IMPORTANT: For registered agents, we do NOT override currentChannel
    // from the header. That is only for spawned subagents joining fresh —
    // the parent sets PI_MESSENGER_CHANNEL in the child's env so the child
    // joins the parent's channel instead of getting a new session channel.
    // For already-registered agents, the header is ignored; explicit
    // channel switches go through the action body's `channel` field.
    //
    // For unregistered agents, the header adds the hinted channel to
    // joinedChannels but does NOT override currentChannel if a session
    // channel will be created later. The session channel is always the
    // agent's "home" channel.
    if (channelHint) {
        const chId = normalizeChannelId(channelHint);
        if (!joinedChannels.includes(chId)) {
            joinedChannels.push(chId);
        }
        // For unregistered agents with a channel hint (spawned subagents),
        // set the hinted channel as currentChannel so executeJoin can
        // restore it after register() overwrites it with a session channel.
        // For already-registered agents, the header is ignored; explicit
        // channel switches go through the action body's `channel` field.
        if (!registered) {
            currentChannel = chId;
            if (!sessionChannel)
                sessionChannel = chId;
        }
        else if (!currentChannel) {
            currentChannel = chId;
            if (!sessionChannel)
                sessionChannel = chId;
        }
    }
    // Resolve session channel if not yet set
    if (!currentChannel && sessionIdFromDisk) {
        const record = ensureSessionChannel(dirs, sessionIdFromDisk, resolvedName || undefined);
        currentChannel = record.id;
        sessionChannel = record.id;
    }
    // Always include memory channel
    const memoryNormalized = normalizeChannelId('memory');
    if (!joinedChannels.includes(memoryNormalized)) {
        joinedChannels.push(memoryNormalized);
    }
    if (currentChannel && !joinedChannels.includes(normalizeChannelId(currentChannel))) {
        joinedChannels.push(normalizeChannelId(currentChannel));
    }
    return {
        state: {
            agentName: resolvedName,
            registered,
            reservations: [],
            chatHistory: new Map(),
            unreadCounts: new Map(),
            channelPostHistory: [],
            seenSenders: new Map(),
            model: '',
            gitBranch,
            spec: undefined,
            scopeToFolder: configForCwd(resolvedCwd).scopeToFolder,
            isHuman: false,
            session: { toolCalls: 0, tokens: 0, filesModified: [] },
            activity: { lastActivityAt: new Date().toISOString() },
            statusMessage: undefined,
            customStatus: false,
            registryFlushTimer: null,
            sessionStartedAt: new Date().toISOString(),
            contextSessionId: sessionIdFromDisk,
            callerPid,
            currentChannel,
            sessionChannel,
            joinedChannels,
        },
        resolvedCwd,
    };
}
function createHarnessContext(sessionId, cwd, callerCwd) {
    return {
        cwd: cwd || normalizeCwd(process.cwd()),
        callerCwd,
        hasUI: false,
        model: 'harness',
        sessionManager: {
            getSessionId: () => sessionId,
        },
        ui: {
            theme: { fg: (_c, t) => t },
            notify: () => { },
            setStatus: () => { },
        },
    };
}
// Pull-based message delivery: messages are written to the channel feed.
// Agents read the feed themselves via `pi-messenger-swarm feed --limit 10`.
// No RPC push — this is kafka-like, not pub/sub.
const deliverMessage = (_msg) => {
    // Messages are already persisted in the feed by the send handler.
    // Agents discover them by reading the feed on their own schedule.
};
const updateStatus = (_ctx) => { };
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SERVER_VERSION = (() => {
    try {
        // __dirname is dist/harness/ — walk up to project root for package.json
        const pkgPath = join(__dirname, '..', '..', 'package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        return pkg.version || 'unknown';
    }
    catch {
        return 'unknown';
    }
})();
const PORT = Number(process.env.PI_MESSENGER_PORT ?? 9877);
const startedAt = Date.now();
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        req.on('error', reject);
    });
}
/**
 * Read an agent-identity header from the request.
 * The CLI forwards these from its own environment.
 */
function header(req, name) {
    const val = req.headers[name.toLowerCase()];
    if (typeof val === 'string')
        return val;
    if (Array.isArray(val))
        return val[0];
    return undefined;
}
const TEXT_JSON = { 'content-type': 'application/json; charset=utf-8' };
const TEXT_PLAIN = { 'content-type': 'text/plain; charset=utf-8' };
function serverLog(msg) {
    const ts = new Date().toISOString();
    const line = `[${ts}] ${msg}\n`;
    const logPath = process.env.PI_MESSENGER_LOG ?? '/tmp/pi-messenger-swarm.log';
    try {
        fs.appendFileSync(logPath, line);
    }
    catch {
        // Best effort
    }
}
const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }
    // Health check — report uptime, known agents, and running spawns
    if (req.method === 'GET' && url.pathname === '/health') {
        const agents = [];
        try {
            for (const f of fs.readdirSync(startupDirs.registry)) {
                if (f.endsWith('.json'))
                    agents.push(f.replace(/\.json$/, ''));
            }
        }
        catch { }
        res.writeHead(200, TEXT_JSON);
        res.end(JSON.stringify({
            ok: true,
            uptime: Math.floor((Date.now() - startedAt) / 1000),
            agents,
            version: SERVER_VERSION,
            cwd: normalizeCwd(process.cwd()),
            runningSpawns: getRunningSpawnCount(),
        }));
        return;
    }
    // Live workers endpoint — returns the harness server's in-memory liveWorkers
    // map so the overlay (running in the main pi process) can display real-time
    // spawn progress. Without this, the overlay's getLiveWorkers() returns empty
    // because updateLiveWorker() only runs in the harness server process.
    if (req.method === 'GET' && url.pathname === '/live-workers') {
        const callerCwd = header(req, 'x-caller-cwd');
        const { getLiveWorkers } = await import('../swarm/live-progress.js');
        const workers = getLiveWorkers(callerCwd || undefined);
        const entries = Array.from(workers.values()).map((w) => ({
            taskId: w.taskId,
            agent: w.agent,
            name: w.name,
            progress: w.progress,
            startedAt: w.startedAt,
        }));
        res.writeHead(200, TEXT_JSON);
        res.end(JSON.stringify({ ok: true, workers: entries }));
        return;
    }
    // Action endpoint
    if (req.method === 'POST' && url.pathname === '/action') {
        let body;
        try {
            body = await readBody(req);
        }
        catch {
            res.writeHead(400, TEXT_JSON);
            res.end(JSON.stringify({ ok: false, error: 'failed to read body' }));
            return;
        }
        let params;
        try {
            params = JSON.parse(body);
        }
        catch {
            res.writeHead(400, TEXT_JSON);
            res.end(JSON.stringify({ ok: false, error: 'invalid JSON' }));
            return;
        }
        const action = params.action;
        if (!action || typeof action !== 'string') {
            res.writeHead(400, TEXT_JSON);
            res.end(JSON.stringify({ ok: false, error: "missing or invalid 'action' field" }));
            return;
        }
        // Resolve agent identity from request headers
        const callerPidStr = header(req, 'x-caller-pid');
        const callerPid = callerPidStr ? parseInt(callerPidStr, 10) : undefined;
        const agentName = header(req, 'x-agent-name');
        const sessionId = header(req, 'x-session-id');
        const channelHint = header(req, 'x-messenger-channel');
        // The CLI sends its cwd so the server can resolve the correct project
        // even when multiple projects share the same harness server.
        const callerCwd = header(req, 'x-caller-cwd');
        // The CLI sends an explicit data-directory override (from a user-set
        // PI_MESSENGER_DIR) via this header. When present it wins over the
        // cwd-derived .pi/messenger path — see getMessengerDirs().
        const messengerDirOverride = header(req, 'x-messenger-dir');
        serverLog(`action: ${action} agent_name: ${agentName || '(none)'} caller_pid: ${callerPid || '(none)'} session: ${sessionId || '(none)'} channel: ${channelHint || '(auto)'} caller_cwd: ${callerCwd || '(none)'}`);
        // Determine the project cwd for this request.
        // Priority: x-caller-cwd header > PI_MESSENGER_CWD env > server process.cwd()
        // The caller always knows its current project, so x-caller-cwd wins.
        // Registration cwd is only used as fallback when no header is present.
        let projectCwd = callerCwd
            ? normalizeCwd(callerCwd)
            : normalizeCwd(process.env.PI_MESSENGER_CWD ?? process.cwd());
        // Pre-resolve state from the startup dirs to read the registration's cwd
        const preState = resolveAgentState(startupDirs, callerPid, agentName, channelHint, sessionId, projectCwd);
        // Use the registration's cwd ONLY as fallback when caller didn't send one
        if (!callerCwd && preState.state.registered && preState.resolvedCwd) {
            projectCwd = preState.resolvedCwd;
        }
        // Re-resolve with project-specific dirs and config
        const dirs = dirsForCwd(projectCwd, messengerDirOverride || undefined);
        const routerConfig = routerConfigForCwd(projectCwd);
        // Build per-request state from disk
        const { state, resolvedCwd } = resolveAgentState(dirs, callerPid, agentName, channelHint, sessionId, projectCwd);
        // Use session ID from header (written by extension to .pi/messenger/session-id)
        // if available, otherwise fall back to the state's contextSessionId (from disk).
        const effectiveSessionId = sessionId || state.contextSessionId || '';
        const ctx = createHarnessContext(effectiveSessionId, resolvedCwd, callerCwd ? normalizeCwd(callerCwd) : undefined);
        // Also update the state's contextSessionId so handlers use it
        state.contextSessionId = effectiveSessionId;
        // If the registration on disk has an empty sessionId but we now have one
        // (from the x-session-id header), patch the registration file so the
        // channel's sessionId and future reads are consistent.
        if (effectiveSessionId && state.registered && state.agentName) {
            const regPath = join(dirs.registry, `${state.agentName}.json`);
            try {
                if (fs.existsSync(regPath)) {
                    const reg = JSON.parse(fs.readFileSync(regPath, 'utf-8'));
                    if (!reg.sessionId) {
                        reg.sessionId = effectiveSessionId;
                        fs.writeFileSync(regPath, JSON.stringify(reg, null, 2));
                    }
                }
            }
            catch {
                // Best effort
            }
            // Also patch the session channel's sessionId if it was created before
            // the session-id file was available.
            const ch = state.currentChannel || state.sessionChannel;
            if (ch) {
                try {
                    patchChannelSessionId(dirs, ch, effectiveSessionId);
                }
                catch {
                    // Best effort
                }
            }
        }
        try {
            const result = await executeAction(action, params, state, dirs, ctx, deliverMessage, updateStatus, undefined, routerConfig);
            let text = '';
            let details = {};
            if (result && typeof result === 'object') {
                if ('content' in result && Array.isArray(result.content)) {
                    text = result.content
                        .map((c) => (typeof c === 'object' && 'text' in c ? c.text : String(c)))
                        .join('\n');
                }
                if ('details' in result && typeof result.details === 'object') {
                    details = result.details;
                }
            }
            else if (typeof result === 'string') {
                text = result;
            }
            res.writeHead(200, TEXT_JSON);
            res.end(JSON.stringify({ ok: true, result: { text, details } }));
            // A successful spawn adds a fresh runtime to the in-memory map. Persist
            // immediately so a harness CRASH in the next ~15s (before the periodic
            // timer) still recovers this agent. This closes the multi-project
            // recovery gap: without it, a non-startup-project agent spawned moments
            // before a crash would be absent from spawn-runtimes.json AND not scanned
            // by reconcileAndRestoreOrphans (which covers startupDirs only), leaving
            // its event log stuck at 'running'. persistRuntimes writes every
            // in-memory runtime across all projects to one file.
            if (action === 'spawn' && !details.error) {
                try {
                    persistRuntimes(startupDirs.base);
                }
                catch {
                    // Best effort — the periodic timer is a backstop
                }
            }
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            serverLog(`error: ${msg}`);
            res.writeHead(500, TEXT_JSON);
            res.end(JSON.stringify({ ok: false, error: msg }));
        }
        return;
    }
    // Soft restart: reload config and dirs caches, but preserve running agents
    // and registrations. Use /quit for a full shutdown that kills everything.
    if (req.method === 'POST' && url.pathname === '/restart') {
        dirsCache.clear();
        clearConfigCache();
        serverLog('soft restart: cleared config and dirs caches');
        res.writeHead(200, TEXT_JSON);
        res.end(JSON.stringify({
            ok: true,
            message: 'Config and dirs caches cleared. Running agents preserved.',
        }));
        return;
    }
    // Graceful shutdown
    // By default, kills all spawned agents (hard quit).
    // With x-preserve-spawns header, persists runtime state to disk and
    // exits without killing spawned agents — they survive as independent
    // processes and the next server instance reconnects via restoreRuntimes().
    if (req.method === 'POST' && url.pathname === '/quit') {
        const preserveSpawns = header(req, 'x-preserve-spawns') === '1';
        if (preserveSpawns) {
            persistRuntimes(startupDirs.base);
            serverLog('graceful shutdown (preserve-spawns): persisted runtimes, not killing spawned agents');
            res.writeHead(200, TEXT_JSON);
            res.end(JSON.stringify({ ok: true, preservedSpawns: true }));
            setTimeout(() => {
                server.close();
                process.exit(0);
            }, 500);
        }
        else {
            stopAllSpawned();
            res.writeHead(200, TEXT_JSON);
            res.end(JSON.stringify({ ok: true }));
            setTimeout(() => {
                forceKillAllSpawned();
                server.close();
                process.exit(0);
            }, 2000);
        }
        return;
    }
    // 404
    res.writeHead(404, TEXT_PLAIN);
    res.end('not found\n');
});
server.listen(PORT, '127.0.0.1', () => {
    const addr = server.address();
    const actualPort = typeof addr === 'object' && addr ? addr.port : PORT;
    const msg = JSON.stringify({
        ok: true,
        ready: true,
        port: actualPort,
        message: `pi-messenger-swarm harness listening on http://127.0.0.1:${actualPort}`,
    });
    process.stdout.write(msg + '\n');
    serverLog(`harness v${SERVER_VERSION} started on port ${actualPort}`);
});
// Graceful shutdown — persist running agent state before exiting so a
// restarted server can reconnect. Only kill spawns on explicit /quit
// without x-preserve-spawns; signal-based shutdown always preserves
// spawned agents (the common case is a version-mismatch restart where
// we want agents to survive).
const shutdown = (signal, preserveSpawns = true) => {
    serverLog(`received ${signal}, shutting down (preserve=${preserveSpawns})`);
    if (preserveSpawns) {
        persistRuntimes(startupDirs.base);
    }
    else {
        stopAllSpawned();
    }
    server.close();
    const delay = preserveSpawns ? 500 : 2000;
    setTimeout(() => {
        if (!preserveSpawns)
            forceKillAllSpawned();
        process.exit(0);
    }, delay);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
// Crash resilience: log errors instead of terminating the process.
// Without these handlers, an unhandled rejection in Node 15+ kills the
// server, orphaning all spawned agents and losing the runtimes map.
process.on('uncaughtException', (err) => {
    serverLog(`uncaughtException: ${err instanceof Error ? err.message : String(err)}`);
    // Don't exit — keep serving. Uncaught exceptions can leave the event
    // loop in an inconsistent state, but for a long-lived harness daemon
    // it's better to log and continue than to kill all in-progress work.
});
process.on('unhandledRejection', (reason) => {
    serverLog(`unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`);
    // Same policy: log and continue rather than crashing.
});
export { server, startupDirs };
