/**
 * Pi Messenger - Swarm Overlay Component
 */
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { displayChannelLabel, getLastActivity, listChannels, ACTIVE_THRESHOLD_MS, } from '../channel.js';
import { getEffectiveSessionId } from '../store/shared.js';
import { syncChannelStateFromDisk } from '../store/agents.js';
import * as taskStore from '../swarm/task-store.js';
import { renderStatusBar, renderWorkersSection, renderLegend, renderDetailView, renderSwarmDetail, renderChannelBar, } from './render-exports.js';
import { createMessengerViewState, setNotification } from './actions.js';
import { handleOverlayInput } from './input.js';
import { generateSwarmSnapshot } from './snapshot.js';
import { buildRenderCacheKey as buildOverlayRenderCacheKey, calculateBasePanelHeights as calculateOverlayBasePanelHeights, ensureFeedWindowInitialized as initializeOverlayFeedWindow, estimateFeedViewportHeight as estimateOverlayFeedViewportHeight, getFeedLineCountCached as getCachedFeedLineCount, getRenderedFeedLineCountFor as getOverlayRenderedFeedLineCountFor, syncFeedWindow as syncOverlayFeedWindow, } from './feed-window.js';
import { computeCompletionState, getSignificantEventMessage, } from './notifications.js';
import { getLiveWorkers, hasLiveWorkers, onLiveWorkersChanged, syncFromRemote, } from '../swarm/live-progress.js';
import { listSpawnedHistory } from '../swarm/spawn.js';
import { loadConfig } from '../config.js';
import { calculateListLayout } from './render-layout.js';
const RENDER_CACHE_TTL_MS = 50;
export class MessengerOverlay {
    tui;
    theme;
    state;
    dirs;
    done;
    callbacks;
    get width() {
        return Math.min(100, Math.max(40, process.stdout.columns ?? 90));
    }
    get height() {
        return Math.max(20, (process.stdout.rows ?? 24) - 2);
    }
    focused = false;
    viewState = createMessengerViewState();
    cwd;
    stuckThresholdMs;
    progressTimer = null;
    progressUnsubscribe = null;
    sawIncompleteWork = false;
    completionTimer = null;
    completionDismissed = false;
    completionStateCache = null;
    feedLineCountCache = null;
    rowCache = new Map();
    rowCacheInnerWidth = null;
    rowCacheSectionWidth = null;
    chromeCache = null;
    renderCache = null;
    discoveredChannelsCache = null;
    autoSwitchedToChannel = new Set();
    lastRenderedChannel = null;
    constructor(tui, theme, state, dirs, done, callbacks) {
        this.tui = tui;
        this.theme = theme;
        this.state = state;
        this.dirs = dirs;
        this.done = done;
        this.callbacks = callbacks;
        this.cwd = process.cwd();
        const cfg = loadConfig(this.cwd);
        this.stuckThresholdMs = cfg.stuckThreshold * 1000;
        for (const key of this.state.unreadCounts.keys()) {
            this.state.unreadCounts.set(key, 0);
        }
        this.progressUnsubscribe = onLiveWorkersChanged(() => {
            this.renderCache = null;
            this.syncRefreshTimers();
            this.tui.requestRender();
        });
        this.syncRefreshTimers();
    }
    syncRefreshTimers() {
        if (hasLiveWorkers(this.cwd) || this.hasRunningSpawns())
            this.startProgressRefresh();
        else
            this.stopProgressRefresh();
    }
    hasRunningSpawns() {
        const sessionId = this.getSessionIdForChannel();
        const spawned = listSpawnedHistory(this.cwd, sessionId);
        return spawned.some((a) => a.status === 'running');
    }
    startProgressRefresh() {
        if (this.progressTimer)
            return;
        this.progressTimer = setInterval(async () => {
            const result = await syncFromRemote(this.cwd);
            if (result.changed || hasLiveWorkers(this.cwd)) {
                this.tui.requestRender();
            }
            if (!hasLiveWorkers(this.cwd) && !this.hasRunningSpawns()) {
                this.stopProgressRefresh();
            }
        }, 1000);
    }
    stopProgressRefresh() {
        if (this.progressTimer) {
            clearInterval(this.progressTimer);
            this.progressTimer = null;
        }
    }
    getSessionIdForChannel() {
        return getEffectiveSessionId(this.cwd, this.state);
    }
    currentChannel() {
        return this.state.currentChannel;
    }
    /**
     * Get the list of discoverable channel IDs on disk, cached with a TTL.
     *
     * Discovery rules:
     * - Channels the main agent has joined: always visible
     * - #memory: always visible (cross-session by design)
     * - Named channels on disk: visible if active (last activity within stale threshold).
     *   Stale named channels are hidden unless joined (like stale session channels).
     *   #memory is always visible (cross-session by design).
     * - Session channels from this session: visible
     * - Session channels from other sessions: HIDDEN by default.
     *   They only appear if the agent has explicitly joined them.
     *   Use `channels --all` to discover them from the CLI.
     */
    getDiscoveredChannelIds() {
        const now = Date.now();
        if (this.discoveredChannelsCache && this.discoveredChannelsCache.expiresAt > now) {
            return this.discoveredChannelsCache.channels;
        }
        const mySessionId = this.state.contextSessionId ?? '';
        const joinedSet = new Set(this.state.joinedChannels);
        const channels = listChannels(this.dirs)
            .filter((c) => {
            // Always show channels the main agent has joined
            if (joinedSet.has(c.id))
                return true;
            // #memory is cross-session by design
            if (c.id === 'memory')
                return true;
            // Named channels: visible if active (last activity within stale threshold).
            // #memory is always visible (caught above). Stale named channels are hidden
            // unless joined — discover via `channels --all`.
            if (c.type === 'named') {
                const lastTs = getLastActivity(this.dirs, c.id);
                const referenceTs = lastTs ?? c.createdAt;
                return Date.now() - new Date(referenceTs).getTime() < ACTIVE_THRESHOLD_MS;
            }
            // Session channels from this session: visible
            if (c.type === 'session' && c.sessionId === mySessionId)
                return true;
            // Session channels from other sessions: hidden by default.
            // Only visible if the agent has explicitly joined them (caught by
            // the joinedSet check above). Otherwise, discover via `channels --all`.
            return false;
        })
            .map((c) => c.id);
        this.discoveredChannelsCache = { channels, expiresAt: now + 2000 };
        return channels;
    }
    /**
     * Count channels that exist on disk (e.g. created by subagents)
     * but aren't in the main agent's joinedChannels.
     */
    getUndiscoveredChannelCount() {
        const joinedSet = new Set(this.state.joinedChannels);
        return this.getDiscoveredChannelIds().filter((id) => !joinedSet.has(id)).length;
    }
    /**
     * Build a merged channel list: joined channels first (in order),
     * then any other channels that exist on disk but aren't joined yet.
     * This ensures subagent-created channels are discoverable in the UI.
     */
    getAllDiscoveredChannels() {
        const joined = this.state.joinedChannels.length > 0
            ? this.state.joinedChannels
            : [this.state.currentChannel];
        const joinedSet = new Set(joined);
        // Discover channels that exist on disk (e.g. created by subagents)
        // but aren't in the main agent's joinedChannels yet.
        const onDisk = this.getDiscoveredChannelIds();
        const all = [...joined];
        for (const ch of onDisk) {
            if (!joinedSet.has(ch)) {
                all.push(ch);
            }
        }
        return all;
    }
    /**
     * Auto-switch to a newly discovered channel (e.g. one created by a subagent).
     * Switches at most once per channel to avoid fighting with the user's
     * manual channel selection.
     */
    autoSwitchToNewChannel() {
        const joinedSet = new Set(this.state.joinedChannels);
        // Find channels that exist on disk but aren't joined and haven't been
        // auto-switched to yet. These are likely created by subagents.
        const onDisk = this.getDiscoveredChannelIds();
        const newChannel = onDisk.find((id) => !joinedSet.has(id) && !this.autoSwitchedToChannel.has(id));
        if (newChannel) {
            this.autoSwitchedToChannel.add(newChannel);
            const switched = this.callbacks.onSwitchChannel?.(newChannel);
            if (switched) {
                setNotification(this.viewState, this.tui, true, `Auto-switched to ${displayChannelLabel(newChannel)}`);
            }
        }
    }
    getFeedLineCountCached(channelId) {
        const next = getCachedFeedLineCount(this.cwd, channelId, this.feedLineCountCache);
        this.feedLineCountCache = next.cache;
        return next.totalLines;
    }
    calculateBasePanelHeights(available, taskCount, hasWorkers, totalFeedLines) {
        return calculateOverlayBasePanelHeights(this.viewState.mainView, available, taskCount, hasWorkers, totalFeedLines);
    }
    estimateFeedViewportHeight(termRows, sectionWidth, taskCount, totalFeedLines) {
        return estimateOverlayFeedViewportHeight({
            theme: this.theme,
            cwd: this.cwd,
            mainView: this.viewState.mainView,
            termRows,
            sectionWidth,
            taskCount,
            totalFeedLines,
        });
    }
    ensureFeedWindowInitialized(channelId, totalFeedLines) {
        initializeOverlayFeedWindow({
            cwd: this.cwd,
            viewState: this.viewState,
            channelId,
            totalFeedLines,
        });
    }
    getRenderedFeedLineCountFor(events, sectionWidth, lastSeenEventTs = this.viewState.lastSeenEventTs) {
        return getOverlayRenderedFeedLineCountFor({
            theme: this.theme,
            viewState: this.viewState,
            events,
            sectionWidth,
            lastSeenEventTs,
        });
    }
    getRenderedFeedLineCount(sectionWidth) {
        return this.getRenderedFeedLineCountFor(this.viewState.feedLoadedEvents, sectionWidth);
    }
    syncFeedWindow(channelId, sectionWidth, totalFeedLines) {
        syncOverlayFeedWindow({
            cwd: this.cwd,
            theme: this.theme,
            viewState: this.viewState,
            channelId,
            sectionWidth,
            totalFeedLines,
        });
    }
    buildRenderCacheKey(params) {
        return buildOverlayRenderCacheKey(this.viewState, params);
    }
    cycleChannel(direction) {
        const allChannels = this.getAllDiscoveredChannels();
        if (allChannels.length <= 1)
            return;
        const currentIndex = Math.max(0, allChannels.indexOf(this.state.currentChannel));
        const nextIndex = (currentIndex + direction + allChannels.length) % allChannels.length;
        const nextChannel = allChannels[nextIndex];
        const switched = this.callbacks.onSwitchChannel?.(nextChannel);
        if (!switched)
            return;
        this.feedLineCountCache = null;
        this.discoveredChannelsCache = null;
        this.viewState.feedLoadedEvents = [];
        this.viewState.feedWindowStart = 0;
        this.viewState.feedWindowEnd = 0;
        this.viewState.feedTotalLines = 0;
        this.viewState.feedLineScrollOffset = 0;
        this.viewState.lastSeenEventTs = null;
        this.viewState.selectedTaskIndex = 0;
        this.viewState.mode = 'list';
        setNotification(this.viewState, this.tui, true, `Switched to ${displayChannelLabel(nextChannel)}`);
        this.tui.requestRender();
    }
    handleInput(data) {
        handleOverlayInput({
            data,
            width: this.width,
            viewState: this.viewState,
            cwd: this.cwd,
            state: this.state,
            dirs: this.dirs,
            tui: this.tui,
            done: this.done,
            onBackground: this.callbacks.onBackground,
            currentChannel: () => this.currentChannel(),
            cycleChannel: (direction) => this.cycleChannel(direction),
            generateSnapshot: () => this.generateSnapshot(),
            cancelCompletionTimer: () => this.cancelCompletionTimer(),
            estimateFeedViewportHeight: (termRows, sectionWidth, taskCount, totalFeedLines) => this.estimateFeedViewportHeight(termRows, sectionWidth, taskCount, totalFeedLines),
            ensureFeedWindowInitialized: (channelId, totalFeedLines) => this.ensureFeedWindowInitialized(channelId, totalFeedLines),
            getRenderedFeedLineCount: (sectionWidth) => this.getRenderedFeedLineCount(sectionWidth),
            termRows: this.height,
        });
    }
    generateSnapshot() {
        return generateSwarmSnapshot(this.cwd, this.currentChannel(), this.state);
    }
    render(_width) {
        // Sync channel state from disk so CLI changes (join, switch)
        // are visible without restarting the session.
        syncChannelStateFromDisk(this.state, this.dirs);
        // Auto-switch to newly discovered channels (e.g. created by subagents).
        // Runs on each render and switches at most once per new channel.
        this.autoSwitchToNewChannel();
        // If the channel changed (e.g. via auto-switch or external state mutation),
        // reset the feed window so it reloads for the new channel.
        const currentCh = this.currentChannel();
        if (this.lastRenderedChannel !== null && this.lastRenderedChannel !== currentCh) {
            this.feedLineCountCache = null;
            this.discoveredChannelsCache = null;
            this.viewState.feedLoadedEvents = [];
            this.viewState.feedWindowStart = 0;
            this.viewState.feedWindowEnd = 0;
            this.viewState.feedTotalLines = 0;
            this.viewState.feedLineScrollOffset = 0;
            this.viewState.lastSeenEventTs = null;
        }
        this.lastRenderedChannel = currentCh;
        const w = this.width;
        const innerW = w - 2;
        const sectionW = innerW - 2;
        const border = (s) => this.theme.fg('dim', s);
        const pad = (s, len) => s + ' '.repeat(Math.max(0, len - visibleWidth(s)));
        const sanitizeRowContent = (content) => content.replaceAll('\r', ' ').replaceAll('\n', ' ').replaceAll('\t', ' ');
        if (this.rowCacheInnerWidth !== innerW || this.rowCacheSectionWidth !== sectionW) {
            this.rowCache.clear();
            this.rowCacheInnerWidth = innerW;
            this.rowCacheSectionWidth = sectionW;
        }
        const row = (content) => {
            const cached = this.rowCache.get(content);
            if (cached)
                return cached;
            const safe = truncateToWidth(sanitizeRowContent(content), sectionW);
            const rendered = border('│') + pad(' ' + safe, innerW) + border('│');
            if (this.rowCache.size > 2048)
                this.rowCache.clear();
            this.rowCache.set(content, rendered);
            return rendered;
        };
        const sectionSeparator = this.theme.fg('dim', '─'.repeat(sectionW));
        const channelId = this.currentChannel();
        const termRows = this.height;
        const initialCachedRender = this.renderCache;
        const ultraEarlyCacheKey = this.buildRenderCacheKey({
            width: w,
            termRows,
            channelId,
            prevTs: this.viewState.lastSeenEventTs,
        });
        if (initialCachedRender &&
            initialCachedRender.expiresAt > Date.now() &&
            initialCachedRender.quickKey === ultraEarlyCacheKey &&
            initialCachedRender.feedEvents === this.viewState.feedLoadedEvents) {
            return initialCachedRender.lines;
        }
        const sessionId = this.getSessionIdForChannel();
        const tasks = taskStore.getTasks(this.cwd, sessionId);
        const spawned = listSpawnedHistory(this.cwd, sessionId);
        const allChannels = this.getAllDiscoveredChannels();
        if (tasks.length === 0) {
            this.viewState.selectedTaskIndex = 0;
            if (this.viewState.mainView === 'tasks' && this.viewState.mode === 'detail') {
                this.viewState.mode = 'list';
            }
        }
        else {
            this.viewState.selectedTaskIndex = Math.max(0, Math.min(this.viewState.selectedTaskIndex, tasks.length - 1));
        }
        if (spawned.length === 0) {
            this.viewState.selectedSwarmIndex = 0;
            if (this.viewState.mainView === 'swarm' && this.viewState.mode === 'detail') {
                this.viewState.mode = 'list';
            }
        }
        else {
            this.viewState.selectedSwarmIndex = Math.max(0, Math.min(this.viewState.selectedSwarmIndex, spawned.length - 1));
        }
        const selectedTask = tasks[this.viewState.selectedTaskIndex] ?? null;
        const selectedSwarmAgent = spawned[this.viewState.selectedSwarmIndex] ?? null;
        if (initialCachedRender) {
            const preFeedSyncCacheKey = this.buildRenderCacheKey({
                width: w,
                termRows,
                channelId,
                totalFeedLines: this.viewState.feedTotalLines,
                taskCount: tasks.length,
                selectedTaskId: selectedTask?.id ?? '',
                selectedSwarmAgentName: selectedSwarmAgent?.name ?? '',
                prevTs: this.viewState.lastSeenEventTs,
            });
            if (initialCachedRender.expiresAt > Date.now() &&
                initialCachedRender.key === preFeedSyncCacheKey &&
                initialCachedRender.tasks === tasks &&
                initialCachedRender.feedEvents === this.viewState.feedLoadedEvents) {
                return initialCachedRender.lines;
            }
        }
        // Progressive feed loading with sparse sliding window
        const totalFeedLines = this.getFeedLineCountCached(channelId);
        this.syncFeedWindow(channelId, sectionW, totalFeedLines);
        const allEvents = this.viewState.feedLoadedEvents;
        // Initialize lastSeenEventTs on first render so existing events appear dim, not highlighted
        if (this.viewState.lastSeenEventTs === null && allEvents.length > 0) {
            this.viewState.lastSeenEventTs = allEvents[allEvents.length - 1].ts;
        }
        const prevTs = this.viewState.lastSeenEventTs;
        if (initialCachedRender) {
            const earlyRenderCacheKey = this.buildRenderCacheKey({
                width: w,
                termRows,
                channelId,
                totalFeedLines,
                taskCount: tasks.length,
                selectedTaskId: selectedTask?.id ?? '',
                selectedSwarmAgentName: selectedSwarmAgent?.name ?? '',
                prevTs,
            });
            if (initialCachedRender.expiresAt > Date.now() &&
                initialCachedRender.key === earlyRenderCacheKey &&
                initialCachedRender.tasks === tasks &&
                initialCachedRender.feedEvents === this.viewState.feedLoadedEvents) {
                return initialCachedRender.lines;
            }
        }
        this.detectAndFlashEvents(allEvents, prevTs);
        this.checkCompletion(tasks);
        const renderCacheKey = this.buildRenderCacheKey({
            width: w,
            termRows,
            channelId,
            totalFeedLines,
            taskCount: tasks.length,
            selectedTaskId: selectedTask?.id ?? '',
            selectedSwarmAgentName: selectedSwarmAgent?.name ?? '',
            prevTs,
        });
        const liveWorkers = getLiveWorkers(this.cwd);
        const lines = [];
        const titleContent = this.renderTitleContent();
        const chromeKey = `${innerW}|${titleContent}`;
        if (!this.chromeCache || this.chromeCache.key !== chromeKey) {
            const titleText = ` ${titleContent} `;
            const titleLen = visibleWidth(titleContent) + 2;
            const borderLen = Math.max(0, innerW - titleLen);
            const leftBorder = Math.floor(borderLen / 2);
            const rightBorder = borderLen - leftBorder;
            this.chromeCache = {
                key: chromeKey,
                titleLine: border('╭' + '─'.repeat(leftBorder)) + titleText + border('─'.repeat(rightBorder) + '╮'),
                emptyLine: border('│') + ' '.repeat(innerW) + border('│'),
                middleBorder: border('├' + '─'.repeat(innerW) + '┤'),
                bottomBorder: border('╰' + '─'.repeat(innerW) + '╯'),
            };
        }
        lines.push(this.chromeCache.titleLine);
        lines.push(row(renderStatusBar(this.theme, this.cwd, sectionW, channelId, liveWorkers, tasks, sessionId, this.getUndiscoveredChannelCount())));
        // Channel bar: only render when there are multiple channels
        if (allChannels.length > 1) {
            lines.push(row(renderChannelBar(this.theme, sectionW, allChannels, channelId)));
        }
        lines.push(this.chromeCache.emptyLine);
        // Calculate legend first to determine dynamic chrome lines
        const legendLines = renderLegend(this.theme, this.cwd, sectionW, this.viewState, selectedTask, selectedSwarmAgent, channelId);
        // chromeLines: title + status + channel bar + empty row + separator + bottom border + legend lines
        const chromeLines = 6 + legendLines.length + (allChannels.length > 1 ? 0 : -1);
        const contentHeight = Math.max(8, termRows - chromeLines);
        // Calculate feed height consistently (must match the calculation in list mode below)
        const workersLimit = termRows <= 26 ? 2 : 5;
        let workerLines = renderWorkersSection(this.theme, this.cwd, sectionW, workersLimit, liveWorkers);
        const agentsHeight = 2;
        const workersHeight = () => (workerLines.length > 0 ? workerLines.length + 1 : 0);
        const available = contentHeight - workersHeight() - agentsHeight;
        let { feedHeight, mainHeight } = this.calculateBasePanelHeights(available, tasks.length, workerLines.length > 0, totalFeedLines);
        let contentLines;
        if (this.viewState.mode === 'detail') {
            if (this.viewState.mainView === 'swarm' && selectedSwarmAgent) {
                contentLines = renderSwarmDetail(selectedSwarmAgent, sectionW, contentHeight, this.viewState);
            }
            else if (this.viewState.mainView === 'tasks' && selectedTask) {
                contentLines = renderDetailView(this.cwd, selectedTask, sectionW, contentHeight, this.viewState, channelId, this.getSessionIdForChannel(), liveWorkers);
            }
            else {
                contentLines = [];
                while (contentLines.length < contentHeight)
                    contentLines.push('');
            }
        }
        else {
            const layout = calculateListLayout({
                theme: this.theme,
                cwd: this.cwd,
                sectionW,
                innerW,
                contentHeight,
                termRows,
                state: this.state,
                dirs: this.dirs,
                stuckThresholdMs: this.stuckThresholdMs,
                viewState: this.viewState,
                liveWorkers,
                tasks,
                spawned,
                feedHeight,
                mainHeight,
                totalFeedLines,
                prevTs,
                currentChannel: this.currentChannel(),
                sessionId,
                feedWindowStart: this.viewState.feedWindowStart,
                feedWindowEnd: this.viewState.feedWindowEnd,
            });
            contentLines = layout.contentLines;
        }
        for (const line of contentLines) {
            lines.push(row(line));
        }
        lines.push(this.chromeCache.middleBorder);
        for (const legendLine of legendLines) {
            lines.push(row(legendLine));
        }
        lines.push(this.chromeCache.bottomBorder);
        if (allEvents.length > 0) {
            this.viewState.lastSeenEventTs = allEvents[allEvents.length - 1].ts;
        }
        this.renderCache = {
            key: renderCacheKey,
            quickKey: ultraEarlyCacheKey,
            expiresAt: Date.now() + RENDER_CACHE_TTL_MS,
            tasks,
            feedEvents: this.viewState.feedLoadedEvents,
            lines,
        };
        return lines;
    }
    detectAndFlashEvents(events, prevTs) {
        const message = getSignificantEventMessage(events, prevTs);
        if (!message)
            return;
        setNotification(this.viewState, this.tui, true, message);
    }
    checkCompletion(tasks) {
        this.completionStateCache = computeCompletionState(tasks, this.completionStateCache);
        const allDone = this.completionStateCache.allDone;
        const isIdle = !hasLiveWorkers(this.cwd);
        if (!allDone) {
            this.sawIncompleteWork = true;
            this.cancelCompletionTimer();
            this.completionDismissed = false;
            return;
        }
        if (isIdle && this.sawIncompleteWork && !this.completionTimer && !this.completionDismissed) {
            setNotification(this.viewState, this.tui, true, 'All tasks complete!');
            this.completionDismissed = true;
        }
    }
    cancelCompletionTimer() {
        if (this.completionTimer) {
            clearTimeout(this.completionTimer);
            this.completionTimer = null;
            this.completionDismissed = true;
        }
    }
    renderTitleContent() {
        const onDisk = this.getDiscoveredChannelIds();
        const joinedSet = new Set(this.state.joinedChannels);
        const isDiscovered = !joinedSet.has(this.currentChannel()) && onDisk.includes(this.currentChannel());
        const label = displayChannelLabel(this.currentChannel());
        const suffix = isDiscovered ? ' (unjoined)' : '';
        return this.theme.fg('accent', `Swarm Messenger · ${label}${suffix}`);
    }
    invalidate() {
        this.renderCache = null;
        this.discoveredChannelsCache = null;
    }
    dispose() {
        this.renderCache = null;
        this.discoveredChannelsCache = null;
        this.stopProgressRefresh();
        this.cancelCompletionTimer();
        if (this.viewState.notificationTimer) {
            clearTimeout(this.viewState.notificationTimer);
            this.viewState.notificationTimer = null;
        }
        this.progressUnsubscribe?.();
        this.progressUnsubscribe = null;
    }
}
