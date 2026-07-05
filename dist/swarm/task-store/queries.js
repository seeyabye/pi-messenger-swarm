import { replayTasks, replayAllTasks } from './events.js';
import { readTaskSpec } from './persistence.js';
import { cleanupStaleTaskClaims } from './cleanup.js';
// Throttled cleanup tracking per cwd+sessionId
const lastCleanupTime = new Map();
const CLEANUP_THROTTLE_MS = 5_000; // Max once per 5 seconds per session
/** Reset cleanup throttle for testing */
export function _resetCleanupThrottle(cwd, sessionId) {
    if (cwd && sessionId) {
        lastCleanupTime.delete(`${cwd}:${sessionId}`);
    }
    else {
        lastCleanupTime.clear();
    }
}
/**
 * Get tasks with throttled cleanup of stale claims.
 */
export function getTasks(cwd, sessionId) {
    const key = `${cwd}:${sessionId}`;
    const now = Date.now();
    const lastCleanup = lastCleanupTime.get(key) ?? 0;
    // Throttled cleanup of stale claims from crashed/departed agents
    if (now - lastCleanup > CLEANUP_THROTTLE_MS) {
        lastCleanupTime.set(key, now);
        try {
            cleanupStaleTaskClaims(cwd, sessionId);
        }
        catch {
            // Ignore errors - cleanup is best-effort
        }
    }
    return replayTasks(cwd, sessionId);
}
export function getAllTasks(cwd, sessionId) {
    return replayAllTasks(cwd, sessionId);
}
export function getTask(cwd, sessionId, taskId) {
    return replayTasks(cwd, sessionId).find((t) => t.id === taskId);
}
export function taskExists(cwd, sessionId, taskId) {
    return getTask(cwd, sessionId, taskId) !== undefined;
}
export function getSummary(cwd, sessionId) {
    return getSummaryForTasks(getTasks(cwd, sessionId));
}
export function getSummaryForTasks(tasks) {
    return {
        total: tasks.length,
        todo: tasks.filter((t) => t.status === 'todo').length,
        in_progress: tasks.filter((t) => t.status === 'in_progress').length,
        done: tasks.filter((t) => t.status === 'done').length,
        blocked: tasks.filter((t) => t.status === 'blocked').length,
    };
}
export function getReadyTasks(cwd, sessionId) {
    return getReadyTasksForTasks(getTasks(cwd, sessionId));
}
export function getReadyTasksForTasks(tasks) {
    const doneIds = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id));
    return tasks.filter((t) => t.status === 'todo' && t.depends_on.every((dep) => doneIds.has(dep)));
}
export function getStalledTasks(cwd, sessionId, stallThresholdMs = 10 * 60 * 1000) {
    const tasks = getTasks(cwd, sessionId);
    const now = Date.now();
    return tasks.filter((task) => {
        if (task.status !== 'in_progress')
            return false;
        // Last activity: most recent progress_log entry, or claimed_at
        const lastActivity = task.progress_log?.length
            ? task.progress_log[task.progress_log.length - 1].timestamp
            : task.claimed_at;
        if (!lastActivity)
            return false;
        return now - Date.parse(lastActivity) >= stallThresholdMs;
    });
}
export function getTaskSpec(cwd, sessionId, taskId) {
    return readTaskSpec(cwd, sessionId, taskId);
}
/**
 * Get progress log for a task from the task's progress_log field.
 */
export function getTaskProgress(cwd, sessionId, taskId) {
    const task = getTask(cwd, sessionId, taskId);
    if (!task?.progress_log || task.progress_log.length === 0)
        return null;
    return task.progress_log
        .map((entry) => {
        const timestamp = new Date(entry.timestamp).toLocaleString();
        return `[${timestamp}] ${entry.agent}: ${entry.message}`;
    })
        .join('\n');
}
