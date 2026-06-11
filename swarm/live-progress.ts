import * as http from 'node:http';
import { normalizeCwd } from '../store/shared.js';
import type { AgentProgress } from './progress.js';

export interface LiveWorkerInfo {
  cwd: string;
  taskId: string;
  agent: string;
  name: string;
  progress: AgentProgress;
  startedAt: number;
}

const liveWorkers = new Map<string, LiveWorkerInfo>();
const listeners = new Set<() => void>();

// Throttle notifications to prevent flickering from rapid updates
const MIN_NOTIFY_INTERVAL_MS = 100;
let lastNotifyTime = 0;
let pendingNotify = false;
let notifyTimer: ReturnType<typeof setTimeout> | null = null;

function getWorkerKey(cwd: string, taskId: string): string {
  return `${cwd}::${taskId}`;
}

// Deep equality check for AgentProgress to avoid unnecessary re-renders
function progressEqual(a: AgentProgress, b: AgentProgress): boolean {
  if (a.toolCallCount !== b.toolCallCount) return false;
  if (a.tokens !== b.tokens) return false;
  if (a.currentTool !== b.currentTool) return false;
  if (a.currentToolArgs !== b.currentToolArgs) return false;
  if (a.recentTools.length !== b.recentTools.length) return false;
  for (let i = 0; i < a.recentTools.length; i++) {
    if (a.recentTools[i].tool !== b.recentTools[i].tool) return false;
    if (a.recentTools[i].args !== b.recentTools[i].args) return false;
  }
  return true;
}

// Check if worker info has meaningfully changed
function workerInfoChanged(
  existing: LiveWorkerInfo | undefined,
  newInfo: Omit<LiveWorkerInfo, 'cwd'>
): boolean {
  if (!existing) return true;
  if (existing.name !== newInfo.name) return true;
  if (existing.agent !== newInfo.agent) return true;
  if (!progressEqual(existing.progress, newInfo.progress)) return true;
  return false;
}

export function updateLiveWorker(
  cwd: string,
  taskId: string,
  info: Omit<LiveWorkerInfo, 'cwd'>
): void {
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

function throttledNotify(): void {
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
  } else if (!pendingNotify) {
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

export function removeLiveWorker(cwd: string, taskId: string): void {
  const key = getWorkerKey(cwd, taskId);
  if (liveWorkers.has(key)) {
    liveWorkers.delete(key);
    throttledNotify();
  }
}

export function getLiveWorkers(cwd?: string): ReadonlyMap<string, LiveWorkerInfo> {
  if (!cwd) return new Map(liveWorkers);

  const filtered = new Map<string, LiveWorkerInfo>();
  for (const info of liveWorkers.values()) {
    if (info.cwd !== cwd) continue;
    filtered.set(info.taskId, info);
  }
  return filtered;
}

export function hasLiveWorkers(cwd?: string): boolean {
  if (!cwd) return liveWorkers.size > 0;
  for (const info of liveWorkers.values()) {
    if (info.cwd === cwd) return true;
  }
  return false;
}

export function onLiveWorkersChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notifyListeners(): void {
  for (const fn of listeners) fn();
}

export interface SyncFromRemoteResult {
  changed: boolean;
  /** Worker keys that were removed (spawn completed/failed/stopped) */
  removedWorkers: Array<{ taskId: string; name: string }>;
}

export async function syncFromRemote(cwd?: string): Promise<SyncFromRemoteResult> {
  const port = Number(process.env.PI_MESSENGER_PORT ?? 9877);
  const url = `http://127.0.0.1:${port}/live-workers`;
  let body: string;
  try {
    body = await new Promise<string>((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (cwd) headers['x-caller-cwd'] = normalizeCwd(cwd);
      const req = http.get(url, { headers, timeout: 2000 }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('timeout'));
      });
    });
  } catch {
    return { changed: false, removedWorkers: [] };
  }
  let parsed: { ok?: boolean; workers?: Array<Omit<LiveWorkerInfo, 'cwd'>> };
  try {
    parsed = JSON.parse(body);
  } catch {
    return { changed: false, removedWorkers: [] };
  }
  if (!parsed.ok || !Array.isArray(parsed.workers)) return { changed: false, removedWorkers: [] };
  const effectiveCwd = cwd ? normalizeCwd(cwd) : undefined;
  let changed = false;
  const remoteKeys = new Set<string>();
  const removedWorkers: Array<{ taskId: string; name: string }> = [];
  for (const w of parsed.workers) {
    const workerCwd = (w as any).cwd || effectiveCwd || '';
    const key = getWorkerKey(workerCwd, w.taskId);
    remoteKeys.add(key);
    const existing = liveWorkers.get(key);
    if (workerInfoChanged(existing, w)) {
      liveWorkers.set(key, { ...w, cwd: workerCwd } as LiveWorkerInfo);
      changed = true;
    }
  }
  for (const [key, info] of liveWorkers.entries()) {
    if (effectiveCwd && info.cwd !== effectiveCwd) continue;
    if (!remoteKeys.has(key)) {
      removedWorkers.push({ taskId: info.taskId, name: info.name });
      liveWorkers.delete(key);
      changed = true;
    }
  }
  if (changed) throttledNotify();
  return { changed, removedWorkers };
}
