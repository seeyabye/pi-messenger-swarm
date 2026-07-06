/**
 * Pi Messenger Extension
 *
 * Enables pi agents to discover and communicate with each other across terminal sessions.
 * Uses file-based coordination with a harness server for action dispatch.
 *
 * Architecture:
 * - This extension manages lifecycle hooks (registration, status, overlay, reservations)
 * - A long-lived harness server (pi-messenger-swarm) handles all action dispatch
 * - Models interact via the CLI, not a tool call — no eager invocation risk
 * - The SKILL.md teaches models how to use the CLI
 */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { truncateToWidth } from '@earendil-works/pi-tui';
import { formatRelativeTime, stripAnsiCodes, extractFolder, } from './lib.js';
import { displayChannelLabel } from './channel.js';
import * as store from './store.js';
import { getContextSessionId, getEffectiveSessionId, isSameProject, normalizeCwd, } from './store/shared.js';
import { syncChannelStateFromDisk } from './store/agents.js';
import { MessengerOverlay } from './overlay/component.js';
import { MessengerConfigOverlay } from './overlay/config-overlay.js';
import { loadConfig, matchesAutoRegisterPath } from './config.js';
import { logFeedEvent, pruneFeed, readFeedEvents } from './feed/index.js';
import { onLiveWorkersChanged, syncFromRemote } from './swarm/live-progress.js';
import { listSpawnedHistory, stopAllSpawned } from './swarm/spawn.js';
import { createDeliverMessage } from './extension/deliver-message.js';
import { createStatusController } from './extension/status.js';
import { createActivityTracker } from './extension/activity.js';
import { installShellAlias, createHarnessServer } from './extension/harness.js';
import { handleReservationEnforcement } from './extension/reservation.js';
import { handleSessionShutdown } from './extension/shutdown.js';
import { isProcessAlive } from './lib.js';
let overlayTui = null;
let overlayHandle = null;
let overlayOpening = false;
export default function piMessengerExtension(pi) {
    const config = loadConfig(process.cwd());
    const state = {
        agentName: '',
        registered: false,
        reservations: [],
        chatHistory: new Map(),
        unreadCounts: new Map(),
        channelPostHistory: [],
        seenSenders: new Map(),
        model: '',
        gitBranch: undefined,
        spec: undefined,
        scopeToFolder: config.scopeToFolder,
        isHuman: false,
        session: { toolCalls: 0, tokens: 0, filesModified: [] },
        activity: { lastActivityAt: new Date().toISOString() },
        statusMessage: undefined,
        customStatus: false,
        registryFlushTimer: null,
        sessionStartedAt: new Date().toISOString(),
        contextSessionId: undefined,
        currentChannel: '',
        sessionChannel: '',
        joinedChannels: [],
    };
    const nameTheme = { theme: config.nameTheme, customWords: config.nameWords };
    function getMessengerDirs() {
        // Normalize (realpath) the base so the extension's paths match the
        // harness server's per-request dirs (which normalize via normalizeCwd).
        // Without this, string comparisons under symlinks disagree even though
        // the underlying files are the same.
        const rawBase = process.env.PI_MESSENGER_DIR ||
            (process.env.PI_MESSENGER_GLOBAL === '1'
                ? join(getAgentDir(), 'messenger')
                : join(process.cwd(), '.pi/messenger'));
        const baseDir = normalizeCwd(rawBase);
        return {
            base: baseDir,
            registry: join(baseDir, 'registry'),
        };
    }
    const dirs = getMessengerDirs();
    const deliverMessage = createDeliverMessage({
        pi,
        state,
        dirs,
        config,
        requestRender: () => overlayTui?.requestRender(),
    });
    const { updateStatus, clearAllUnreadCounts, resetChannelScopedUiState } = createStatusController({
        state,
        dirs,
        config,
        maybeAutoOpenSwarmOverlay,
    });
    function syncContextSession(ctx) {
        if (!state.registered)
            return;
        const rebound = store.rebindContextSession(state, dirs, ctx);
        if (!rebound.changed)
            return;
        const cwd = ctx.cwd ?? process.cwd();
        if (rebound.previousSessionChannel && rebound.previousSessionChannel !== state.sessionChannel) {
            logFeedEvent(cwd, state.agentName, 'leave', undefined, undefined, rebound.previousSessionChannel);
        }
        resetChannelScopedUiState();
        logFeedEvent(cwd, state.agentName, 'join', undefined, undefined, state.currentChannel);
        overlayTui?.requestRender();
        updateStatus(ctx);
    }
    const STATUS_HEARTBEAT_MS = 15_000;
    let latestCtx = null;
    let statusHeartbeatTimer = null;
    /** Guard against stale extension contexts after session replacement/reload. */
    function safeUpdateStatus(ctx) {
        if (!ctx)
            return;
        try {
            // Accessing ctx.hasUI throws if the context is stale
            void ctx.hasUI;
            updateStatus(ctx);
        }
        catch {
            // Stale context — skip this update; the next session_start will set a fresh ctx
        }
    }
    function startStatusHeartbeat() {
        if (statusHeartbeatTimer)
            return;
        statusHeartbeatTimer = setInterval(() => {
            safeUpdateStatus(latestCtx);
        }, STATUS_HEARTBEAT_MS);
    }
    function stopStatusHeartbeat() {
        if (!statusHeartbeatTimer)
            return;
        clearInterval(statusHeartbeatTimer);
        statusHeartbeatTimer = null;
    }
    onLiveWorkersChanged(() => {
        safeUpdateStatus(latestCtx);
        overlayTui?.requestRender();
    });
    // Spawn completion detection: poll spawn history for agents that
    // completed since the last check and notify the main agent.
    // Checks the event-sourced jsonl files directly (not the live-workers
    // map) so it works even if the worker appeared and disappeared
    // between poll intervals.
    const SPAWN_POLL_MS = 3_000;
    let spawnPollTimer = null;
    // Spawn-completion dedup: spawn ids only (bounded by this session's spawn
    // count). We deliberately do NOT prune this set — the old FIFO prune
    // evicted historical ids and the next full-history scan re-notified them.
    // Memory is modest for any realistic session.
    const notifiedSpawnIds = new Set();
    // Per-channel message cursor: the max message timestamp we've already
    // push-notified. Replaces a dedup set that was FIFO-pruned (which caused
    // re-notification of evicted keys). Feed events are append-only and
    // time-ordered, so a high-water mark per channel dedupes without unbounded
    // growth and without re-notifying history.
    const notifiedMessageTsByChannel = new Map();
    let primedSpawnCompletions = false;
    function startSpawnCompletionPoll() {
        if (spawnPollTimer)
            return;
        spawnPollTimer = setInterval(async () => {
            // Prime the notification set with already-completed agents so we don't
            // re-notify about historical completions on extension reload.
            // Must happen here (after registration) because getEffectiveSessionId
            // depends on state.currentChannel which is set during register().
            const cwd = normalizeCwd(process.cwd());
            if (!primedSpawnCompletions) {
                primedSpawnCompletions = true;
                try {
                    const sessionId = getEffectiveSessionId(cwd, state);
                    const existing = listSpawnedHistory(cwd, sessionId);
                    for (const agent of existing) {
                        if (agent.status !== 'running' && agent.id) {
                            notifiedSpawnIds.add(agent.id);
                        }
                    }
                    // Prime the per-channel message cursor with the newest existing
                    // targeted message so we don't re-notify history on reload.
                    // Messages that arrived while this session was offline are
                    // intentionally suppressed here (read them via `feed`); see SKILL.md.
                    if (state.agentName) {
                        const channels = state.joinedChannels.length > 0
                            ? state.joinedChannels
                            : state.currentChannel
                                ? [state.currentChannel]
                                : [];
                        for (const channelId of channels) {
                            try {
                                const events = readFeedEvents(cwd, 50, channelId);
                                let maxTs = notifiedMessageTsByChannel.get(channelId) ?? 0;
                                for (const event of events) {
                                    if (event.type === 'message' && event.target === state.agentName) {
                                        const ts = Date.parse(event.ts);
                                        if (Number.isFinite(ts) && ts > maxTs)
                                            maxTs = ts;
                                    }
                                }
                                if (maxTs > 0)
                                    notifiedMessageTsByChannel.set(channelId, maxTs);
                            }
                            catch {
                                // Best effort
                            }
                        }
                    }
                }
                catch {
                    // Best effort
                }
            }
            // Also sync live workers for the overlay
            const result = await syncFromRemote(cwd);
            if (result.changed)
                safeUpdateStatus(latestCtx);
            overlayTui?.requestRender();
            // Check spawn history for completed agents we haven't notified about
            const sessionId = getEffectiveSessionId(cwd, state);
            const spawned = listSpawnedHistory(cwd, sessionId);
            for (const agent of spawned) {
                if (agent.status === 'running')
                    continue;
                // Only notify about agents that belong to THIS project.
                // Agents from other projects may exist in the same agents directory
                // when the harness server's cwd resolution was incorrect. Use
                // isSameProject (resolves to nearest .git/.pi root) so an agent
                // running from a project subdirectory still matches a spawn whose
                // projectCwd is the project root — strict equality dropped these.
                if (agent.projectCwd && !isSameProject(agent.projectCwd, cwd))
                    continue;
                // Deduplicate by spawn id (no prune — see notifiedSpawnIds comment)
                if (notifiedSpawnIds.has(agent.id))
                    continue;
                notifiedSpawnIds.add(agent.id);
                const statusLabel = agent.status === 'completed'
                    ? 'completed'
                    : agent.status === 'failed'
                        ? 'failed'
                        : 'stopped';
                const taskInfo = agent.taskId ? ` (task: ${agent.taskId})` : '';
                const summary = agent.status === 'completed'
                    ? agent.objective || 'Mission complete'
                    : agent.error || 'Unknown error';
                pi.sendMessage({
                    customType: 'spawn_completion',
                    content: `🔔 Spawned agent ${agent.name} (${agent.role}) ${statusLabel}${taskInfo}. ` +
                        `Summary: ${summary}. ` +
                        (agent.taskId
                            ? `Check output: pi-messenger-swarm task show ${agent.taskId}`
                            : `Use pi-messenger-swarm spawn history for details.`),
                    display: true,
                }, { triggerTurn: true });
            }
            // Check for unread messages addressed to this agent
            // and push-notify so the agent can respond immediately.
            if (state.agentName) {
                const channels = state.joinedChannels.length > 0
                    ? state.joinedChannels
                    : state.currentChannel
                        ? [state.currentChannel]
                        : [];
                for (const channelId of channels) {
                    let events;
                    try {
                        events = readFeedEvents(cwd, 50, channelId);
                    }
                    catch {
                        continue;
                    }
                    for (const event of events) {
                        if (event.type !== 'message')
                            continue;
                        if (event.target !== state.agentName)
                            continue;
                        // Deduplicate via per-channel timestamp cursor (see
                        // notifiedMessageTsByChannel comment): notify only messages newer
                        // than the last one we pushed.
                        //
                        // Tradeoff vs the old per-message set key: two targeted messages
                        // that share the same millisecond timestamp, or a later-appended
                        // message whose ts is earlier than the cursor (cross-process clock
                        // skew / NTP rollback), are skipped and remain readable only via
                        // `feed`. This is acceptable: same-ms collisions are rare, the
                        // feed is the durable source of truth, and the cursor keeps memory
                        // bounded without the old FIFO prune that re-notified evicted keys.
                        const ts = Date.parse(event.ts);
                        if (!Number.isFinite(ts))
                            continue;
                        if (ts <= (notifiedMessageTsByChannel.get(channelId) ?? 0))
                            continue;
                        notifiedMessageTsByChannel.set(channelId, ts);
                        pi.sendMessage({
                            customType: 'swarm_message',
                            content: `📩 Message from ${event.agent} on #${channelId}: ${event.preview || '(no content)'}. ` +
                                `Read full context: pi-messenger-swarm feed --limit 20`,
                            display: true,
                        }, { triggerTurn: true });
                    }
                }
            }
        }, SPAWN_POLL_MS);
    }
    function stopSpawnCompletionPoll() {
        if (!spawnPollTimer)
            return;
        clearInterval(spawnPollTimer);
        spawnPollTimer = null;
    }
    function sendRegistrationContext(ctx) {
        const folder = extractFolder(process.cwd());
        const locationPart = state.gitBranch ? `${folder} on ${state.gitBranch}` : folder;
        pi.sendMessage({
            customType: 'messenger_context',
            content: `You are agent "${state.agentName}" in ${locationPart}. Your current channel is ${displayChannelLabel(state.currentChannel)}. Named channel ${displayChannelLabel('memory')} exists for durable cross-session notes. Use pi-messenger-swarm for all coordination. Key: when you spawn agents for tasks, delegate the work — do NOT claim those tasks yourself (spawned agents claim and execute them). Only claim tasks you will implement personally. Read agent output with task show (feed shows only previews). IMPORTANT: spawned agents run asynchronously — you will be notified automatically on completion. Do NOT use bash sleep or polling loops to wait for spawned agents. End your turn or continue other work; Pi will deliver the completion notification when the agent finishes. Examples: pi-messenger-swarm join | pi-messenger-swarm swarm | pi-messenger-swarm task create --title "..." | pi-messenger-swarm spawn --task-id task-1 --role Debugger "Fix X" | pi-messenger-swarm task show task-1 | pi-messenger-swarm send AgentName "hello" | pi-messenger-swarm feed --limit 20. See SKILL for full reference.`,
            display: false,
        }, { triggerTurn: false });
    }
    const harnessServer = createHarnessServer(dirs.base);
    pi.registerCommand('messenger', {
        description: "Open messenger overlay, or 'config' to manage settings",
        handler: async (args, ctx) => {
            if (!ctx.hasUI)
                return;
            latestCtx = ctx;
            syncContextSession(ctx);
            // /messenger config - open config overlay
            if (args[0] === 'config') {
                await ctx.ui.custom((tui, theme, _keybindings, done) => {
                    return new MessengerConfigOverlay(tui, theme, done);
                }, { overlay: true });
                return;
            }
            // /messenger - open chat overlay (auto-joins if not registered)
            if (!state.registered) {
                if (!store.register(state, dirs, ctx, nameTheme)) {
                    ctx.ui.notify('Failed to join agent mesh', 'error');
                    return;
                }
                updateStatus(ctx);
                if (config.registrationContext) {
                    sendRegistrationContext(ctx);
                }
            }
            // Sync channel state from disk so the overlay opens on the
            // most recent active channel (e.g. a named channel the agent
            // joined via the CLI), not a stale session channel.
            syncChannelStateFromDisk(state, dirs);
            if (overlayHandle && overlayHandle.isHidden()) {
                overlayHandle.setHidden(false);
                clearAllUnreadCounts();
                updateStatus(ctx);
                return;
            }
            const callbacks = {
                onBackground: (snapshotText) => {
                    overlayHandle?.setHidden(true);
                    pi.sendMessage({
                        customType: 'swarm_snapshot',
                        content: snapshotText,
                        display: true,
                    }, { triggerTurn: true });
                },
                onSwitchChannel: (channelId) => {
                    const switched = store.joinChannel(state, dirs, channelId, { create: true });
                    if (!switched.success)
                        return false;
                    resetChannelScopedUiState();
                    updateStatus(ctx);
                    return true;
                },
            };
            const snapshot = await ctx.ui.custom((tui, theme, _keybindings, done) => {
                overlayTui = tui;
                return new MessengerOverlay(tui, theme, state, dirs, done, callbacks);
            }, {
                overlay: true,
                onHandle: (handle) => {
                    overlayHandle = handle;
                },
            });
            if (snapshot) {
                pi.sendMessage({
                    customType: 'swarm_snapshot',
                    content: snapshot,
                    display: true,
                }, { triggerTurn: true });
            }
            // Overlay closed
            clearAllUnreadCounts();
            overlayHandle = null;
            overlayTui = null;
            updateStatus(ctx);
        },
    });
    pi.registerMessageRenderer('agent_message', (message, _options, theme) => {
        const details = message.details;
        if (!details)
            return undefined;
        return {
            render(width) {
                const safeFrom = stripAnsiCodes(details.from);
                const safeText = stripAnsiCodes(details.text);
                const header = theme.fg('accent', `From ${safeFrom}`);
                const time = theme.fg('dim', ` (${formatRelativeTime(details.timestamp)})`);
                const result = [];
                result.push(truncateToWidth(header + time, width));
                result.push('');
                for (const line of safeText.split('\n')) {
                    result.push(truncateToWidth(line, width));
                }
                return result;
            },
            invalidate() { },
        };
    });
    const activityTracker = createActivityTracker({ state, dirs, config });
    pi.on('tool_call', async (event, ctx) => {
        await activityTracker.handleToolCall(event, ctx);
    });
    pi.on('tool_result', async (event, ctx) => {
        await activityTracker.handleToolResult(event, ctx);
    });
    pi.on('session_start', async (_event, ctx) => {
        latestCtx = ctx;
        startStatusHeartbeat();
        startSpawnCompletionPoll();
        state.isHuman = ctx.hasUI;
        try {
            fs.rmSync(join(getAgentDir(), 'messenger/feed.jsonl'), { force: true });
        }
        catch { }
        syncContextSession(ctx);
        // Write the session ID to disk so the harness server (and CLI)
        // can discover it. The harness runs as a separate process and
        // has no access to pi's SessionManager — this file bridges that gap.
        //
        // IMPORTANT: Skip for spawned subagents (PI_SWARM_SPAWNED=1).
        // Subagents share the same project directory as the parent, so
        // writing their session ID would overwrite the parent's file.
        // The next parent CLI call would then read the child's session ID
        // and trigger a spurious session-mismatch reset, creating orphan
        // session channels.
        //
        // Per-pid entry (sessions/<pid>): the singleton `session-id` file is
        // overwritten by whichever pi session started last, so two concurrent
        // sessions in the same project would both resolve the last writer's id.
        // The per-pid entry lets each session's CLI pick its own id by caller
        // pid (see harness/session-id.ts). The singleton is kept as a fallback.
        const sessionId = getContextSessionId(ctx);
        if (sessionId && !process.env.PI_SWARM_SPAWNED) {
            try {
                fs.writeFileSync(join(dirs.base, 'session-id'), sessionId, 'utf-8');
                const sessionsDir = join(dirs.base, 'sessions');
                fs.mkdirSync(sessionsDir, { recursive: true });
                fs.writeFileSync(join(sessionsDir, String(process.pid)), sessionId, 'utf-8');
                // Sweep stale per-pid entries left by pi sessions that exited without
                // a clean shutdown (crash, kill -9). PID recycling makes a stale file
                // briefly resolve to the wrong id until the recycled pid's session
                // overwrites it; removing dead-pid files keeps the window negligible.
                try {
                    for (const entry of fs.readdirSync(sessionsDir)) {
                        const pidStr = entry;
                        const pid = parseInt(pidStr, 10);
                        if (!Number.isInteger(pid) || pid === process.pid)
                            continue;
                        if (!isProcessAlive(pid)) {
                            try {
                                fs.unlinkSync(join(sessionsDir, entry));
                            }
                            catch {
                                // Best effort
                            }
                        }
                    }
                }
                catch {
                    // Best effort
                }
            }
            catch {
                // Best effort
            }
        }
        // Install the CLI wrapper so all child bash processes
        // can find and use pi-messenger-swarm.
        installShellAlias();
        const shouldAutoRegister = config.autoRegister || matchesAutoRegisterPath(process.cwd(), config.autoRegisterPaths);
        // Start the harness server even without auto-register —
        // the model needs it for CLI actions regardless.
        if (!process.env.PI_SWARM_SPAWNED) {
            harnessServer.start();
        }
        if (!shouldAutoRegister) {
            maybeAutoOpenSwarmOverlay(ctx);
            return;
        }
        const wasRegistered = state.registered;
        if (store.register(state, dirs, ctx, nameTheme)) {
            updateStatus(ctx);
            if (!wasRegistered) {
                const cwd = ctx.cwd ?? process.cwd();
                pruneFeed(cwd, config.feedRetention, state.currentChannel);
                logFeedEvent(cwd, state.agentName, 'join', undefined, undefined, state.currentChannel);
            }
            if (config.registrationContext) {
                sendRegistrationContext(ctx);
            }
        }
        maybeAutoOpenSwarmOverlay(ctx);
    });
    function maybeAutoOpenSwarmOverlay(_ctx) {
        // Swarm mode intentionally disables planning/autonomous auto-overlay behavior.
    }
    pi.on('session_start', async (event, ctx) => {
        // Handle new, resume, and fork reasons (existing sessions), not startup/reload
        if (event.reason === 'startup' || event.reason === 'reload')
            return;
        latestCtx = ctx;
        syncContextSession(ctx);
        updateStatus(ctx);
        maybeAutoOpenSwarmOverlay(ctx);
    });
    pi.on('session_tree', async (_event, ctx) => {
        latestCtx = ctx;
        updateStatus(ctx);
        maybeAutoOpenSwarmOverlay(ctx);
    });
    pi.on('turn_end', async (event, ctx) => {
        latestCtx = ctx;
        syncContextSession(ctx);
        updateStatus(ctx);
        if (state.registered) {
            const msg = event.message;
            if (msg && msg.role === 'assistant' && msg.usage) {
                const usage = msg.usage;
                const total = usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0);
                if (total > 0) {
                    state.session.tokens += total;
                    activityTracker.scheduleRegistryFlush(ctx);
                }
            }
        }
        maybeAutoOpenSwarmOverlay(ctx);
    });
    pi.on('agent_end', async (_event, ctx) => {
        latestCtx = ctx;
        updateStatus(ctx);
    });
    pi.on('session_shutdown', async () => {
        latestCtx = null; // Prevent stale context use after shutdown
        const cwd = process.cwd();
        stopAllSpawned(cwd); // In-process safety net for extension-spawned agents
        stopStatusHeartbeat();
        stopSpawnCompletionPoll();
        // Do NOT send /quit to the harness server on session shutdown.
        // The harness is a long-lived daemon (detached + unref'd) designed to
        // survive across pi sessions. Killing it destroys all spawned subagents
        // that may still be working. The harness handles agent cleanup via its
        // own session tracking — it will unregister this session's agent when
        // handleSessionShutdown runs below. If the harness truly needs to stop,
        // the user can run `pi-messenger-swarm --stop` explicitly.
        harnessServer.stop(); // Only stops the process WE spawned (if any)
        // Remove our per-pid session-id entry so a recycled PID doesn't briefly
        // resolve to our (now-ended) session id. The startup sweep also removes
        // stale entries, but cleaning up here avoids leaving a dead-pid file.
        if (!process.env.PI_SWARM_SPAWNED) {
            try {
                fs.unlinkSync(join(dirs.base, 'sessions', String(process.pid)));
            }
            catch {
                // Best effort — file may not exist
            }
        }
        overlayOpening = false;
        overlayHandle = null;
        overlayTui = null;
        await handleSessionShutdown(state, dirs);
        activityTracker.dispose();
    });
    pi.on('tool_call', async (event, ctx) => {
        return handleReservationEnforcement(event, ctx, state, dirs);
    });
}
