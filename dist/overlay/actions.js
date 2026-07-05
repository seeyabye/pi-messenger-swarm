import { randomUUID } from 'node:crypto';
import { matchesKey } from '@earendil-works/pi-tui';
import { MAX_CHAT_HISTORY } from '../lib.js';
import { getActiveAgents, resolveTargetChannel } from '../store.js';
import { logFeedEvent } from '../feed/index.js';
import * as taskStore from '../swarm/task-store.js';
import { executeTaskAction as runTaskAction } from '../swarm/task-actions.js';
import { getLiveWorkers } from '../swarm/live-progress.js';
// Throttle render requests during typing to reduce lag
// This coalesces multiple keystrokes into a single render
const RENDER_THROTTLE_MS = 16; // ~60fps, enough for smooth typing without blocking
const renderTimers = new WeakMap();
function requestRenderThrottled(tui) {
    const existing = renderTimers.get(tui);
    if (existing) {
        // Already scheduled, don't queue another
        return;
    }
    const timer = setTimeout(() => {
        renderTimers.delete(tui);
        tui.requestRender();
    }, RENDER_THROTTLE_MS);
    renderTimers.set(tui, timer);
}
export function createMessengerViewState() {
    return {
        scrollOffset: 0,
        selectedTaskIndex: 0,
        selectedSwarmIndex: 0,
        swarmScrollOffset: 0,
        mainView: 'tasks',
        mode: 'list',
        detailScroll: 0,
        detailAutoScroll: true,
        confirmAction: null,
        blockReasonInput: '',
        messageInput: '',
        inputMode: 'normal',
        lastSeenEventTs: null,
        notification: null,
        notificationTimer: null,
        mentionCandidates: [],
        mentionIndex: -1,
        pendingG: false,
        expandFeedMessages: false,
        // Progressive feed loading - sparse window, initially empty
        feedLoadedEvents: [],
        feedWindowStart: 0,
        feedWindowEnd: 0,
        feedTotalLines: 0,
        // Line-based feed scroll
        feedLineScrollOffset: 0, // Start at bottom
        wasAtBottom: true,
    };
}
function hasLiveWorker(cwd, taskId) {
    return getLiveWorkers(cwd).has(taskId);
}
function isPrintable(data) {
    return data.length > 0 && data.charCodeAt(0) >= 32;
}
function executeTaskAction(cwd, sessionId, action, taskId, agentName, channelId, reason) {
    if (action !== 'start' &&
        action !== 'block' &&
        action !== 'unblock' &&
        action !== 'delete' &&
        action !== 'archive' &&
        action !== 'stop') {
        return { success: false, message: `Unknown action: ${action}` };
    }
    const result = runTaskAction(cwd, sessionId, action, taskId, agentName, channelId, reason, {
        isWorkerActive: (id) => hasLiveWorker(cwd, id),
    });
    return { success: result.success, message: result.message };
}
export function setNotification(viewState, tui, success, message) {
    if (viewState.notificationTimer)
        clearTimeout(viewState.notificationTimer);
    viewState.notification = {
        message: `${success ? '✓' : '✗'} ${message}`,
        expiresAt: Date.now() + 2000,
    };
    viewState.notificationTimer = setTimeout(() => {
        viewState.notificationTimer = null;
        tui.requestRender();
    }, 2000);
}
function addToChatHistory(state, recipient, message) {
    let history = state.chatHistory.get(recipient);
    if (!history) {
        history = [];
        state.chatHistory.set(recipient, history);
    }
    history.push(message);
    if (history.length > MAX_CHAT_HISTORY)
        history.shift();
}
function addToChannelPostHistory(state, text) {
    const channelPostMsg = {
        id: randomUUID(),
        from: state.agentName,
        to: state.currentChannel,
        text,
        timestamp: new Date().toISOString(),
        replyTo: null,
        channel: state.currentChannel,
    };
    state.channelPostHistory.push(channelPostMsg);
    if (state.channelPostHistory.length > MAX_CHAT_HISTORY) {
        state.channelPostHistory.shift();
    }
}
function previewText(text) {
    return text;
}
export function handleConfirmInput(data, viewState, cwd, agentName, channelId, sessionId, tui) {
    const action = viewState.confirmAction;
    if (!action)
        return;
    if (matchesKey(data, 'y')) {
        const result = executeTaskAction(cwd, sessionId, action.type, action.taskId, agentName, channelId);
        if (action.type === 'delete' || action.type === 'archive') {
            const tasks = taskStore.getTasks(cwd, sessionId);
            if (tasks.length > 0) {
                viewState.selectedTaskIndex = Math.max(0, Math.min(viewState.selectedTaskIndex, tasks.length - 1));
            }
            else {
                viewState.selectedTaskIndex = 0;
                if (viewState.mode === 'detail')
                    viewState.mode = 'list';
            }
        }
        viewState.confirmAction = null;
        setNotification(viewState, tui, result.success, result.message);
        tui.requestRender();
        return;
    }
    if (matchesKey(data, 'n') || matchesKey(data, 'escape')) {
        viewState.confirmAction = null;
        tui.requestRender();
    }
}
export function handleBlockReasonInput(data, viewState, cwd, task, agentName, channelId, sessionId, tui) {
    if (matchesKey(data, 'escape')) {
        viewState.inputMode = 'normal';
        viewState.blockReasonInput = '';
        tui.requestRender();
        return;
    }
    if (matchesKey(data, 'enter')) {
        const reason = viewState.blockReasonInput.trim();
        if (!reason || !task)
            return;
        const result = executeTaskAction(cwd, sessionId, 'block', task.id, agentName, channelId, reason);
        viewState.inputMode = 'normal';
        viewState.blockReasonInput = '';
        setNotification(viewState, tui, result.success, result.message);
        tui.requestRender();
        return;
    }
    if (matchesKey(data, 'backspace')) {
        if (viewState.blockReasonInput.length > 0) {
            viewState.blockReasonInput = viewState.blockReasonInput.slice(0, -1);
            requestRenderThrottled(tui);
        }
        return;
    }
    if (isPrintable(data)) {
        viewState.blockReasonInput += data;
        requestRenderThrottled(tui);
    }
}
function resetMessageInput(viewState) {
    viewState.inputMode = 'normal';
    viewState.messageInput = '';
    viewState.mentionCandidates = [];
    viewState.mentionIndex = -1;
}
function collectMentionCandidates(prefix, state, dirs, cwd) {
    const seen = new Set();
    const names = [];
    for (const agent of getActiveAgents(state, dirs)) {
        if (agent.name === state.agentName)
            continue;
        if (!seen.has(agent.name)) {
            seen.add(agent.name);
            names.push(agent.name);
        }
    }
    for (const worker of getLiveWorkers(cwd).values()) {
        if (!seen.has(worker.name)) {
            seen.add(worker.name);
            names.push(worker.name);
        }
    }
    names.push('all');
    if (!prefix)
        return names;
    const lower = prefix.toLowerCase();
    return names.filter((n) => n.toLowerCase().startsWith(lower));
}
function sendDirectMessage(state, dirs, cwd, target, text, tui, viewState) {
    try {
        const targetChannel = resolveTargetChannel(dirs, target) ?? state.currentChannel;
        // Log to feed as @mention - all messaging is now feed-based
        logFeedEvent(cwd, state.agentName, 'message', target, previewText(text), targetChannel);
        resetMessageInput(viewState);
        setNotification(viewState, tui, true, `Posted to ${targetChannel}`);
        tui.requestRender();
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown error';
        setNotification(viewState, tui, false, `Failed to send: ${msg}`);
        tui.requestRender();
    }
}
function sendChannelPost(state, _dirs, cwd, text, tui, viewState) {
    // All messaging is now feed-based - no inbox delivery
    addToChannelPostHistory(state, text);
    logFeedEvent(cwd, state.agentName, 'message', undefined, previewText(text), state.currentChannel);
    resetMessageInput(viewState);
    const channelLabel = state.currentChannel.startsWith('#')
        ? state.currentChannel
        : `#${state.currentChannel}`;
    setNotification(viewState, tui, true, `Posted to ${channelLabel}`);
    tui.requestRender();
}
export function handleMessageInput(data, viewState, state, dirs, cwd, tui) {
    if (matchesKey(data, 'escape')) {
        resetMessageInput(viewState);
        tui.requestRender();
        return;
    }
    if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) {
        const input = viewState.messageInput;
        const cycling = viewState.mentionIndex >= 0 && viewState.mentionCandidates.length > 0;
        if (!input.startsWith('@') || (input.includes(' ') && !cycling))
            return;
        const reverse = matchesKey(data, 'shift+tab');
        if (!cycling) {
            const prefix = input.slice(1);
            viewState.mentionCandidates = collectMentionCandidates(prefix, state, dirs, cwd);
            if (viewState.mentionCandidates.length === 0)
                return;
            viewState.mentionIndex = 0;
        }
        else {
            const delta = reverse ? -1 : 1;
            viewState.mentionIndex =
                (viewState.mentionIndex + delta + viewState.mentionCandidates.length) %
                    viewState.mentionCandidates.length;
        }
        viewState.messageInput = `@${viewState.mentionCandidates[viewState.mentionIndex]} `;
        tui.requestRender();
        return;
    }
    if (matchesKey(data, 'enter')) {
        const raw = viewState.messageInput.trim();
        if (!raw)
            return;
        if (raw.startsWith('@all ')) {
            const text = raw.slice(5).trim();
            if (!text)
                return;
            sendChannelPost(state, dirs, cwd, text, tui, viewState);
            return;
        }
        if (raw.startsWith('@')) {
            const firstSpace = raw.indexOf(' ');
            if (firstSpace <= 1) {
                setNotification(viewState, tui, false, 'Use @name <message> or type to post to the current channel');
                tui.requestRender();
                return;
            }
            const target = raw.slice(1, firstSpace).trim();
            const text = raw.slice(firstSpace + 1).trim();
            if (!target || !text) {
                setNotification(viewState, tui, false, 'Use @name <message> or type to post to the current channel');
                tui.requestRender();
                return;
            }
            sendDirectMessage(state, dirs, cwd, target, text, tui, viewState);
            return;
        }
        sendChannelPost(state, dirs, cwd, raw, tui, viewState);
        return;
    }
    if (matchesKey(data, 'backspace')) {
        if (viewState.messageInput.length > 0) {
            viewState.messageInput = viewState.messageInput.slice(0, -1);
            viewState.mentionCandidates = [];
            viewState.mentionIndex = -1;
            requestRenderThrottled(tui);
        }
        return;
    }
    if (isPrintable(data)) {
        viewState.messageInput += data;
        viewState.mentionCandidates = [];
        viewState.mentionIndex = -1;
        requestRenderThrottled(tui);
    }
}
export function handleTaskKeyBinding(data, task, viewState, cwd, agentName, channelId, sessionId, tui) {
    if (matchesKey(data, 'u') && task.status === 'blocked') {
        const result = executeTaskAction(cwd, sessionId, 'unblock', task.id, agentName, channelId);
        setNotification(viewState, tui, result.success, result.message);
        tui.requestRender();
        return;
    }
    if (matchesKey(data, 'b') && task.status === 'in_progress') {
        viewState.inputMode = 'block-reason';
        viewState.blockReasonInput = '';
        tui.requestRender();
        return;
    }
    if (matchesKey(data, 'x')) {
        if (task.status !== 'done') {
            setNotification(viewState, tui, false, 'Only done tasks can be archived');
            tui.requestRender();
            return;
        }
        viewState.confirmAction = { type: 'archive', taskId: task.id, label: task.title };
        tui.requestRender();
        return;
    }
}
