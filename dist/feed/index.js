/**
 * Pi Messenger - Activity Feed
 *
 * Now stored in unified channel JSONL files at channels/<channel>.jsonl
 * Line 1: Metadata header (ChannelMetaHeader)
 * Line 2+: Feed events (FeedEvent)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeChannelId, channelPath, appendChannelEventLine, pruneChannelEvents, isMetaHeader, } from '../channel.js';
const FEED_CACHE_TTL_MS = 100;
const feedCache = new Map();
function unifiedChannelPath(cwd, channelId) {
    // Construct a minimal Dirs-like structure for path resolution
    const base = path.join(cwd, '.pi', 'messenger');
    return channelPath({ base, registry: '' }, channelId);
}
export function invalidateFeedCache(cwd, channelId) {
    const p = unifiedChannelPath(cwd, channelId);
    feedCache.delete(p);
}
function sanitizeInlineText(value) {
    if (!value)
        return undefined;
    const normalized = value
        .replaceAll('\r', ' ')
        .replaceAll('\n', ' ')
        .replaceAll('\t', ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return normalized.length > 0 ? normalized : undefined;
}
function sanitizePreview(value) {
    if (!value)
        return undefined;
    // Preserve newlines for multi-line previews, but normalize other whitespace
    const normalized = value.replaceAll('\r', '\n').replaceAll('\t', ' ').replace(/ +/g, ' ').trim();
    return normalized.length > 0 ? normalized : undefined;
}
function sanitizeAgentName(value) {
    return sanitizeInlineText(value) ?? 'unknown';
}
export function sanitizeFeedEvent(event) {
    return {
        ts: event.ts,
        type: event.type,
        agent: sanitizeAgentName(event.agent),
        target: sanitizeInlineText(event.target),
        preview: sanitizePreview(event.preview),
        channel: event.channel ? normalizeChannelId(event.channel) : undefined,
    };
}
function parseEventLine(line) {
    try {
        const parsed = JSON.parse(line);
        // Skip metadata headers
        if (isMetaHeader(parsed))
            return null;
        const e = parsed;
        if (typeof e.ts === 'string' && typeof e.agent === 'string' && typeof e.type === 'string') {
            return sanitizeFeedEvent(e);
        }
    }
    catch {
        // Skip malformed lines
    }
    return null;
}
function loadFeedCache(cwd, channelId) {
    const p = unifiedChannelPath(cwd, channelId);
    const now = Date.now();
    const cached = feedCache.get(p);
    if (cached && cached.expiresAt > now) {
        return cached;
    }
    if (!fs.existsSync(p)) {
        feedCache.delete(p);
        return null;
    }
    try {
        const stat = fs.statSync(p);
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
            cached.expiresAt = now + FEED_CACHE_TTL_MS;
            return cached;
        }
        const content = fs.readFileSync(p, 'utf-8').trim();
        if (!content) {
            const empty = {
                mtimeMs: stat.mtimeMs,
                size: stat.size,
                expiresAt: now + FEED_CACHE_TTL_MS,
                lines: [],
                events: [],
            };
            feedCache.set(p, empty);
            return empty;
        }
        const lines = content.split('\n');
        const events = [];
        for (const line of lines) {
            const event = parseEventLine(line);
            if (event)
                events.push(event);
        }
        const entry = {
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            expiresAt: now + FEED_CACHE_TTL_MS,
            lines,
            events,
        };
        feedCache.set(p, entry);
        return entry;
    }
    catch {
        feedCache.delete(p);
        return null;
    }
}
export function appendFeedEvent(cwd, event, channelId) {
    const p = unifiedChannelPath(cwd, channelId);
    try {
        const dir = path.dirname(p);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const sanitized = sanitizeFeedEvent({ ...event, channel: normalizeChannelId(channelId) });
        const eventLine = JSON.stringify(sanitized);
        // Use the channel module's append function for unified storage
        const baseDir = path.join(cwd, '.pi', 'messenger');
        const mockDirs = { base: baseDir, registry: '' };
        appendChannelEventLine(mockDirs, channelId, eventLine);
        invalidateFeedCache(cwd, channelId);
    }
    catch {
        // Best effort
    }
}
export function readFeedEvents(cwd, limit, channelId) {
    const entry = loadFeedCache(cwd, channelId);
    if (!entry)
        return [];
    return limit ? entry.events.slice(-limit) : entry.events;
}
export function readFeedEventsWithOffset(cwd, offsetFromEnd, limit, channelId) {
    const entry = loadFeedCache(cwd, channelId);
    if (!entry)
        return [];
    const totalEvents = entry.events.length;
    const endIndex = totalEvents - offsetFromEnd;
    const startIndex = Math.max(0, endIndex - limit);
    if (startIndex >= endIndex || endIndex <= 0)
        return [];
    return entry.events.slice(startIndex, endIndex);
}
export function readFeedEventsByRange(cwd, startIndex, endIndex, channelId) {
    const entry = loadFeedCache(cwd, channelId);
    if (!entry)
        return [];
    const totalEvents = entry.events.length;
    const clampedStart = Math.max(0, Math.min(startIndex, totalEvents));
    const clampedEnd = Math.max(0, Math.min(endIndex, totalEvents));
    if (clampedStart >= clampedEnd)
        return [];
    return entry.events.slice(clampedStart, clampedEnd);
}
export function getFeedLineCount(cwd, channelId) {
    const entry = loadFeedCache(cwd, channelId);
    return entry?.events.length ?? 0;
}
export function pruneFeed(cwd, maxEvents, channelId) {
    const baseDir = path.join(cwd, '.pi', 'messenger');
    const mockDirs = { base: baseDir, registry: '' };
    pruneChannelEvents(mockDirs, channelId, maxEvents);
    invalidateFeedCache(cwd, channelId);
}
const SWARM_EVENT_TYPES = new Set([
    'task.start',
    'task.done',
    'task.block',
    'task.unblock',
    'task.reset',
    'task.delete',
    'task.archive',
    'task.split',
    'task.revise',
    'task.revise-tree',
    'plan.start',
    'plan.pass.start',
    'plan.pass.done',
    'plan.review.start',
    'plan.review.done',
    'plan.done',
    'plan.cancel',
    'plan.failed',
    'spawn.completed',
    'spawn.failed',
    'spawn.stopped',
]);
export function formatFeedLine(event) {
    const sanitized = sanitizeFeedEvent(event);
    const time = new Date(sanitized.ts).toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    });
    const isSwarm = SWARM_EVENT_TYPES.has(sanitized.type);
    const prefix = isSwarm ? '[Swarm] ' : '';
    let line = `${time} ${prefix}${sanitized.agent}`;
    const rawPreview = sanitized.preview;
    const normalizedPreview = rawPreview?.replace(/\n/g, ' ');
    const preview = normalizedPreview
        ? normalizedPreview.length > 90
            ? normalizedPreview.slice(0, 87) + '...'
            : normalizedPreview
        : '';
    const withPreview = (base) => (preview ? `${base} — ${preview}` : base);
    const target = sanitized.target ?? '';
    switch (sanitized.type) {
        case 'join':
            line += ' joined';
            break;
        case 'leave':
            line = withPreview(line + ' left');
            break;
        case 'reserve':
            line += ` reserved ${target}`;
            break;
        case 'release':
            line += ` released ${target}`;
            break;
        case 'message':
            if (target) {
                line += ` → ${target}`;
                if (preview)
                    line += `: ${preview}`;
            }
            else {
                line += ' ✦';
                if (preview)
                    line += ` ${preview}`;
            }
            break;
        case 'commit':
            line += preview ? ` committed "${preview}"` : ' committed';
            break;
        case 'test':
            line += preview ? ` ran tests (${preview})` : ' ran tests';
            break;
        case 'edit':
            line += ` editing ${target}`;
            break;
        case 'task.start':
            line += withPreview(` started ${target}`);
            break;
        case 'task.done':
            line += withPreview(` completed ${target}`);
            break;
        case 'task.block':
            line += withPreview(` blocked ${target}`);
            break;
        case 'task.unblock':
            line += withPreview(` unblocked ${target}`);
            break;
        case 'task.reset':
            line += withPreview(` reset ${target}`);
            break;
        case 'task.delete':
            line += withPreview(` deleted ${target}`);
            break;
        case 'task.archive':
            line += withPreview(` archived ${target || 'done tasks'}`);
            break;
        case 'task.split':
            line += withPreview(` split ${target}`);
            break;
        case 'task.revise':
            line += withPreview(` revised ${target}`);
            break;
        case 'task.revise-tree':
            line += withPreview(` revised ${target} + dependents`);
            break;
        case 'plan.start':
            line += withPreview(' planning started');
            break;
        case 'plan.pass.start':
            line += withPreview(' planning pass started');
            break;
        case 'plan.pass.done':
            line += withPreview(' planning pass finished');
            break;
        case 'plan.review.start':
            line += withPreview(' planning review started');
            break;
        case 'plan.review.done':
            line += withPreview(' planning review finished');
            break;
        case 'plan.done':
            line += withPreview(' planning completed');
            break;
        case 'plan.cancel':
            line += ' planning cancelled';
            break;
        case 'plan.failed':
            line += withPreview(' planning failed');
            break;
        case 'stuck':
            line += ' appears stuck';
            break;
        case 'spawn.completed':
            line += withPreview(` completed spawn ${target}`);
            break;
        case 'spawn.failed':
            line += withPreview(` spawn ${target} failed`);
            break;
        case 'spawn.stopped':
            line += withPreview(` stopped spawn ${target}`);
            break;
        default:
            line += ` ${sanitized.type}`;
            break;
    }
    return line;
}
export function isSwarmEvent(type) {
    return SWARM_EVENT_TYPES.has(type);
}
export function logFeedEvent(cwd, agent, type, target, preview, channelId) {
    appendFeedEvent(cwd, {
        ts: new Date().toISOString(),
        agent,
        type,
        target,
        preview,
        channel: channelId,
    }, channelId);
}
