import * as fs from 'node:fs';
import * as path from 'node:path';
import { getTasksJsonlPath, ensureDir } from './persistence.js';
/**
 * Append a task event to the session's JSONL log.
 */
export function appendTaskEvent(cwd, sessionId, event) {
    const filePath = getTasksJsonlPath(cwd, sessionId);
    ensureDir(path.dirname(filePath));
    fs.appendFileSync(filePath, JSON.stringify(event) + '\n', 'utf-8');
}
/**
 * Internal: replay events and build task map. Shared logic for replayTasks/replayAllTasks.
 */
export function replayEventsToMap(cwd, sessionId) {
    const filePath = getTasksJsonlPath(cwd, sessionId);
    if (!fs.existsSync(filePath))
        return new Map();
    const tasksById = new Map();
    const content = fs.readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
        if (!line.trim())
            continue;
        try {
            const event = JSON.parse(line);
            const existing = tasksById.get(event.taskId);
            switch (event.type) {
                case 'created': {
                    const payload = event.payload;
                    const task = {
                        id: event.taskId,
                        title: payload.title,
                        status: 'todo',
                        depends_on: payload.dependsOn ?? [],
                        created_at: event.timestamp,
                        updated_at: event.timestamp,
                        created_by: payload.createdBy,
                        channel: event.channel,
                        attempt_count: 0,
                    };
                    tasksById.set(event.taskId, task);
                    break;
                }
                case 'claimed': {
                    if (!existing)
                        continue;
                    const payload = event.payload;
                    existing.status = 'in_progress';
                    existing.claimed_by = event.agent;
                    existing.claimed_at = event.timestamp;
                    existing.claim_reason = payload.reason;
                    existing.attempt_count = (existing.attempt_count ?? 0) + 1;
                    existing.updated_at = event.timestamp;
                    break;
                }
                case 'released': {
                    if (!existing)
                        continue;
                    existing.status = 'todo';
                    delete existing.claimed_by;
                    delete existing.claimed_at;
                    delete existing.claim_reason;
                    existing.updated_at = event.timestamp;
                    break;
                }
                case 'progress': {
                    if (!existing)
                        continue;
                    const payload = event.payload;
                    if (!existing.progress_log)
                        existing.progress_log = [];
                    existing.progress_log.push({
                        timestamp: event.timestamp,
                        agent: event.agent ?? 'unknown',
                        message: payload.message,
                    });
                    existing.updated_at = event.timestamp;
                    break;
                }
                case 'completed': {
                    if (!existing)
                        continue;
                    const payload = event.payload;
                    existing.status = 'done';
                    existing.completed_at = event.timestamp;
                    existing.completed_by = event.agent;
                    existing.summary = payload.summary;
                    existing.evidence = payload.evidence;
                    existing.updated_at = event.timestamp;
                    break;
                }
                case 'blocked': {
                    if (!existing)
                        continue;
                    const payload = event.payload;
                    existing.status = 'blocked';
                    existing.blocked_reason = payload.reason;
                    existing.blocked_by = payload.blockedBy;
                    existing.updated_at = event.timestamp;
                    break;
                }
                case 'unblocked': {
                    if (!existing)
                        continue;
                    if (existing.claimed_by) {
                        existing.status = 'in_progress';
                    }
                    else {
                        existing.status = 'todo';
                    }
                    delete existing.blocked_reason;
                    delete existing.blocked_by;
                    existing.updated_at = event.timestamp;
                    break;
                }
                case 'reset': {
                    if (!existing)
                        continue;
                    existing.status = 'todo';
                    delete existing.claimed_by;
                    delete existing.claimed_at;
                    delete existing.claim_reason;
                    delete existing.completed_at;
                    delete existing.completed_by;
                    delete existing.summary;
                    delete existing.evidence;
                    delete existing.blocked_reason;
                    delete existing.blocked_by;
                    existing.updated_at = event.timestamp;
                    break;
                }
                case 'archived': {
                    if (!existing)
                        continue;
                    existing.status = 'archived';
                    existing.archived_at = event.timestamp;
                    existing.updated_at = event.timestamp;
                    break;
                }
            }
        }
        catch {
            // Skip malformed lines
        }
    }
    return tasksById;
}
function taskNumericId(taskId) {
    const match = taskId.match(/(\d+)$/);
    if (!match)
        return Number.MAX_SAFE_INTEGER;
    return Number.parseInt(match[1], 10);
}
/**
 * Replay all events to build current task states.
 * Events are applied in order per taskId, with later events overriding earlier state.
 */
export function replayTasks(cwd, sessionId) {
    const tasksById = replayEventsToMap(cwd, sessionId);
    return Array.from(tasksById.values())
        .filter((t) => t.status !== 'archived')
        .sort((a, b) => taskNumericId(b.id) - taskNumericId(a.id));
}
/**
 * Get all tasks including archived ones.
 */
export function replayAllTasks(cwd, sessionId) {
    const tasksById = replayEventsToMap(cwd, sessionId);
    return Array.from(tasksById.values()).sort((a, b) => taskNumericId(b.id) - taskNumericId(a.id));
}
