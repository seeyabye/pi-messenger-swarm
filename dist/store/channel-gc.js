import * as fs from 'node:fs';
import * as path from 'node:path';
import { isProcessAlive } from '../lib.js';
import { deleteChannel, hasChannelEvents, listChannels, normalizeChannelId } from '../channel.js';
import { getAgentsInChannel } from './agents.js';
import { invalidateFeedCache } from '../feed/index.js';
/**
 * Collect the set of session IDs backed by a live process, by scanning the
 * per-pid session files (sessions/<pid> -> sessionId). Used to avoid deleting
 * a session channel whose owning process is still running.
 */
export function getLiveSessionIds(dirs) {
    const live = new Set();
    const sessionsDir = path.join(dirs.base, 'sessions');
    let files;
    try {
        files = fs.readdirSync(sessionsDir);
    }
    catch {
        return live;
    }
    for (const file of files) {
        const pid = Number(file);
        if (!Number.isInteger(pid) || pid <= 0)
            continue;
        if (!isProcessAlive(pid))
            continue;
        try {
            const id = fs.readFileSync(path.join(sessionsDir, file), 'utf-8').trim();
            if (id)
                live.add(id);
        }
        catch {
            // ignore unreadable session files
        }
    }
    return live;
}
/**
 * Delete orphaned session channels: those that are header-only (no feed
 * events), have no live agent joined, and whose owning session is no longer
 * running. Named channels (e.g. #memory) and session channels with history
 * are always preserved. Safe to run repeatedly.
 *
 * Safety: a session channel is only removed when we can *confirm* it is dead —
 * its sessionId is set (not an in-flight race where the header was written
 * before the session id was patched) and no live process backs it. Channels
 * with an empty sessionId are kept (we cannot prove they are dead).
 */
export function pruneOrphanedSessionChannels(state, dirs, cwd, options) {
    const live = getLiveSessionIds(dirs);
    const current = options?.currentSessionId?.trim();
    const deleted = [];
    const kept = [];
    for (const channel of listChannels(dirs)) {
        if (channel.type !== 'session')
            continue;
        // Preserve any channel with feed history.
        if (hasChannelEvents(dirs, channel.id)) {
            kept.push(channel.id);
            continue;
        }
        // Preserve any channel a live agent is currently joined to.
        if (getAgentsInChannel(state, dirs, channel.id).length > 0) {
            kept.push(channel.id);
            continue;
        }
        // Only delete when we can confirm the owning session is dead: sessionId
        // is set (not an in-flight race), no live process backs it, and it is not
        // the current agent's own session (always live, even before the
        // sessions/<pid> file is written).
        if (!channel.sessionId ||
            live.has(channel.sessionId) ||
            (current && channel.sessionId === current)) {
            kept.push(channel.id);
            continue;
        }
        // Orphan: header-only, no live agents, dead session.
        if (!options?.dryRun) {
            deleteChannel(dirs, channel.id);
            invalidateFeedCache(cwd, normalizeChannelId(channel.id));
        }
        deleted.push(channel.id);
    }
    return { deleted, kept };
}
