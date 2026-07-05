import * as http from 'node:http';
import { normalizeCwd } from '../store/shared.js';
const liveWorkers = new Map();
const listeners = new Set();
// Throttle notifications to prevent flickering from rapid updates
const MIN_NOTIFY_INTERVAL_MS = 100;
let lastNotifyTime = 0;
let pendingNotify = false;
let notifyTimer = null;
function getWorkerKey(cwd, taskId) {
    return `${cwd}::${taskId}`;
}
// Deep equality check for AgentProgress to avoid unnecessary re-renders
function progressEqual(a, b) {
    if (a.toolCallCount !== b.toolCallCount)
        return false;
    if (a.tokens !== b.tokens)
        return false;
    if (a.currentTool !== b.currentTool)
        return false;
    if (a.currentToolArgs !== b.currentToolArgs)
        return false;
    if (a.recentTools.length !== b.recentTools.length)
        return false;
    for (let i = 0; i < a.recentTools.length; i++) {
        if (a.recentTools[i].tool !== b.recentTools[i].tool)
            return false;
        if (a.recentTools[i].args !== b.recentTools[i].args)
            return false;
    }
    return true;
}
// Check if worker info has meaningfully changed
function workerInfoChanged(existing, newInfo) {
    if (!existing)
        return true;
    if (existing.name !== newInfo.name)
        return true;
    if (existing.agent !== newInfo.agent)
        return true;
    if (!progressEqual(existing.progress, newInfo.progress))
        return true;
    return false;
}
export function updateLiveWorker(cwd, taskId, info) {
    const key = getWorkerKey(cwd, taskId);
    const existing = liveWorkers.get(key);
    // Only update and notify if something meaningful changed
    if (!workerInfoChanged(existing, info)) {
        return;
    }
    liveWorkers.set(key, {
        ...info,
        cwd,
    });
    throttledNotify();
}
function throttledNotify() {
    const now = Date.now();
    const timeSinceLastNotify = now - lastNotifyTime;
    if (timeSinceLastNotify >= MIN_NOTIFY_INTERVAL_MS) {
        // Enough time has passed, notify immediately
        if (notifyTimer) {
            clearTimeout(notifyTimer);
            notifyTimer = null;
        }
        pendingNotify = false;
        lastNotifyTime = now;
        notifyListeners();
    }
    else if (!pendingNotify) {
        // Schedule a notification for later
        pendingNotify = true;
        notifyTimer = setTimeout(() => {
            notifyTimer = null;
            pendingNotify = false;
            lastNotifyTime = Date.now();
            notifyListeners();
        }, MIN_NOTIFY_INTERVAL_MS - timeSinceLastNotify);
    }
    // If pendingNotify is true, a notification is already scheduled
}
export function removeLiveWorker(cwd, taskId) {
    const key = getWorkerKey(cwd, taskId);
    if (liveWorkers.has(key)) {
        liveWorkers.delete(key);
        throttledNotify();
    }
}
export function getLiveWorkers(cwd) {
    if (!cwd)
        return new Map(liveWorkers);
    const filtered = new Map();
    for (const info of liveWorkers.values()) {
        if (info.cwd !== cwd)
            continue;
        filtered.set(info.taskId, info);
    }
    return filtered;
}
export function hasLiveWorkers(cwd) {
    if (!cwd)
        return liveWorkers.size > 0;
    for (const info of liveWorkers.values()) {
        if (info.cwd === cwd)
            return true;
    }
    return false;
}
export function onLiveWorkersChanged(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}
function notifyListeners() {
    for (const fn of listeners)
        fn();
}
export async function syncFromRemote(cwd) {
    const port = Number(process.env.PI_MESSENGER_PORT ?? 9877);
    const url = `http://127.0.0.1:${port}/live-workers`;
    let body;
    try {
        body = await new Promise((resolve, reject) => {
            const headers = {};
            if (cwd)
                headers['x-caller-cwd'] = normalizeCwd(cwd);
            const req = http.get(url, { headers, timeout: 2000 }, (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
            });
            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('timeout'));
            });
        });
    }
    catch {
        return { changed: false, removedWorkers: [] };
    }
    let parsed;
    try {
        parsed = JSON.parse(body);
    }
    catch {
        return { changed: false, removedWorkers: [] };
    }
    if (!parsed.ok || !Array.isArray(parsed.workers))
        return { changed: false, removedWorkers: [] };
    const effectiveCwd = cwd ? normalizeCwd(cwd) : undefined;
    let changed = false;
    const remoteKeys = new Set();
    const removedWorkers = [];
    for (const w of parsed.workers) {
        const workerCwd = w.cwd || effectiveCwd || '';
        const key = getWorkerKey(workerCwd, w.taskId);
        remoteKeys.add(key);
        const existing = liveWorkers.get(key);
        if (workerInfoChanged(existing, w)) {
            liveWorkers.set(key, { ...w, cwd: workerCwd });
            changed = true;
        }
    }
    for (const [key, info] of liveWorkers.entries()) {
        if (effectiveCwd && info.cwd !== effectiveCwd)
            continue;
        if (!remoteKeys.has(key)) {
            removedWorkers.push({ taskId: info.taskId, name: info.name });
            liveWorkers.delete(key);
            changed = true;
        }
    }
    if (changed)
        throttledNotify();
    return { changed, removedWorkers };
}
