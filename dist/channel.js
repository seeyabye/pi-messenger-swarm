import * as fs from 'node:fs';
import * as path from 'node:path';
import { generateMemorableName } from './lib.js';
export const CHANNEL_META_VERSION = 1;
export const MEMORY_CHANNEL_ID = 'memory';
/** Threshold in ms after which a channel without activity is considered stale. */
export const ACTIVE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
export const DEFAULT_NAMED_CHANNELS = [
    { id: MEMORY_CHANNEL_ID, description: 'Cross-session knowledge and insights' },
];
function ensureDir(dir) {
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
}
export function getChannelsDir(dirs) {
    return path.join(dirs.base, 'channels');
}
export function normalizeChannelId(value) {
    const trimmed = value.trim();
    const withoutHash = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
    return (withoutHash || value).toLowerCase();
}
export function isValidChannelId(value) {
    if (!value)
        return false;
    return /^[a-z0-9][a-z0-9._-]{0,79}$/.test(normalizeChannelId(value));
}
export function isSessionChannelId(value) {
    return normalizeChannelId(value).startsWith('session-');
}
export function displayChannelLabel(channelId) {
    const normalized = normalizeChannelId(channelId);
    return `#${normalized}`;
}
/** Returns the path to the unified channel JSONL file (metadata + feed) */
export function channelPath(dirs, channelId) {
    return path.join(getChannelsDir(dirs), `${normalizeChannelId(channelId)}.jsonl`);
}
function createMetaHeader(record) {
    return {
        _meta: true,
        v: CHANNEL_META_VERSION,
        id: record.id,
        type: record.type,
        createdAt: record.createdAt,
        createdBy: record.createdBy,
        sessionId: record.sessionId,
        description: record.description,
    };
}
export function isMetaHeader(obj) {
    if (!obj || typeof obj !== 'object')
        return false;
    const o = obj;
    return o._meta === true && typeof o.v === 'number' && typeof o.id === 'string';
}
function metaHeaderToRecord(header) {
    return {
        id: header.id,
        type: header.type,
        createdAt: header.createdAt,
        createdBy: header.createdBy,
        sessionId: header.sessionId,
        description: header.description,
    };
}
function normalizeChannelRecord(raw, fallbackId) {
    const id = normalizeChannelId(raw?.id || fallbackId);
    if (!isValidChannelId(id))
        return null;
    const type = raw?.type === 'session' || raw?.type === 'named'
        ? raw.type
        : raw?.sessionId
            ? 'session'
            : isSessionChannelId(id)
                ? 'session'
                : 'named';
    return {
        id,
        type,
        createdAt: raw?.createdAt || new Date(0).toISOString(),
        createdBy: raw?.createdBy,
        sessionId: raw?.sessionId,
        description: raw?.description,
    };
}
/**
 * Read the metadata header from a channel JSONL file.
 * Returns null if file doesn't exist or has invalid header.
 */
export function readChannelHeader(dirs, channelId) {
    const filePath = channelPath(dirs, channelId);
    if (!fs.existsSync(filePath))
        return null;
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const firstLine = content.split('\n')[0];
        if (!firstLine)
            return null;
        const parsed = JSON.parse(firstLine);
        if (isMetaHeader(parsed)) {
            return parsed;
        }
    }
    catch {
        // Ignore parse errors
    }
    return null;
}
/** Get the timestamp of the last feed event in a channel, or null if no events. */
export function getLastActivity(dirs, channelId) {
    try {
        const events = readChannelEventLines(dirs, channelId);
        if (events.length === 0)
            return null;
        const last = JSON.parse(events[events.length - 1]);
        return last?.ts ?? null;
    }
    catch {
        return null;
    }
}
/**
 * Read all event lines from a channel JSONL file (skips the metadata header).
 * Returns raw JSON strings, not parsed objects.
 */
export function readChannelEventLines(dirs, channelId) {
    const filePath = channelPath(dirs, channelId);
    if (!fs.existsSync(filePath))
        return [];
    try {
        const content = fs.readFileSync(filePath, 'utf-8').trim();
        if (!content)
            return [];
        const lines = content.split('\n');
        // Skip first line (metadata header)
        return lines.slice(1).filter((line) => line.trim());
    }
    catch {
        return [];
    }
}
/**
 * Return true if a channel has any feed events (more than just the metadata
 * header). Cheaper than readChannelEventLines when only presence is needed:
 * it returns as soon as the first event line is found, without building the
 * full array of events.
 */
export function hasChannelEvents(dirs, channelId) {
    const filePath = channelPath(dirs, channelId);
    if (!fs.existsSync(filePath))
        return false;
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        // First line is the metadata header; any subsequent non-empty line is an event.
        for (let i = 1; i < lines.length; i++) {
            if (lines[i].trim())
                return true;
        }
        return false;
    }
    catch {
        return false;
    }
}
/**
 * Append a single event line to a channel JSONL file.
 * Creates the file with metadata header if it doesn't exist.
 */
export function appendChannelEventLine(dirs, channelId, eventLine, meta) {
    const filePath = channelPath(dirs, channelId);
    try {
        ensureDir(getChannelsDir(dirs));
        if (!fs.existsSync(filePath)) {
            // Create new file with minimal metadata header
            const header = {
                _meta: true,
                v: CHANNEL_META_VERSION,
                id: normalizeChannelId(channelId),
                type: isSessionChannelId(channelId) ? 'session' : 'named',
                createdAt: new Date().toISOString(),
                createdBy: meta?.createdBy,
                sessionId: meta?.sessionId,
                description: meta?.description,
            };
            fs.writeFileSync(filePath, JSON.stringify(header) + '\n' + eventLine + '\n');
        }
        else {
            fs.appendFileSync(filePath, eventLine + '\n');
        }
    }
    catch {
        // Best effort
    }
}
/**
 * Prune events in a channel JSONL file to keep only the last N events.
 * Preserves the metadata header.
 */
export function pruneChannelEvents(dirs, channelId, maxEvents) {
    const filePath = channelPath(dirs, channelId);
    if (!fs.existsSync(filePath))
        return;
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        if (lines.length <= 1)
            return; // Only header or empty
        const header = lines[0];
        const events = lines.slice(1).filter((line) => line.trim());
        if (events.length <= maxEvents)
            return;
        const pruned = events.slice(-maxEvents);
        fs.writeFileSync(filePath, header + '\n' + pruned.join('\n') + '\n');
    }
    catch {
        // Best effort
    }
}
/**
 * Delete a channel's JSONL file (metadata header + feed events).
 * Returns true if the file existed and was removed. Does not touch the
 * in-process feed cache; callers should invalidate it separately
 * (see invalidateFeedCache in feed/index.ts).
 */
export function deleteChannel(dirs, channelId) {
    const filePath = channelPath(dirs, channelId);
    if (!fs.existsSync(filePath))
        return false;
    try {
        fs.unlinkSync(filePath);
        return true;
    }
    catch {
        return false;
    }
}
export function getChannel(dirs, channelId) {
    const header = readChannelHeader(dirs, channelId);
    if (header) {
        return metaHeaderToRecord(header);
    }
    return null;
}
export function listChannels(dirs) {
    const dir = getChannelsDir(dirs);
    if (!fs.existsSync(dir))
        return [];
    const items = [];
    for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.jsonl'))
            continue;
        const filePath = path.join(dir, file);
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const firstLine = content.split('\n')[0];
            if (!firstLine)
                continue;
            const parsed = JSON.parse(firstLine);
            if (isMetaHeader(parsed)) {
                items.push(metaHeaderToRecord(parsed));
            }
        }
        catch {
            // Ignore malformed channel files
        }
    }
    return items.sort((a, b) => a.id.localeCompare(b.id));
}
export function writeChannel(dirs, record) {
    ensureDir(getChannelsDir(dirs));
    const filePath = channelPath(dirs, record.id);
    const metaHeader = createMetaHeader(record);
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    // Write metadata header as first line, preserving any existing events
    let existingEvents = [];
    if (fs.existsSync(filePath)) {
        try {
            existingEvents = readChannelEventLines(dirs, record.id);
        }
        catch {
            // Ignore read errors, start fresh
        }
    }
    const lines = [JSON.stringify(metaHeader), ...existingEvents];
    fs.writeFileSync(tmp, lines.join('\n') + '\n');
    fs.renameSync(tmp, filePath);
    return record;
}
/**
 * Patch the sessionId on a channel's metadata header if it's currently empty.
 * Used by the harness server when it discovers the session ID after the channel
 * was already created (race condition with session-id file).
 * Returns true if the channel was patched, false if no change was needed.
 */
export function patchChannelSessionId(dirs, channelId, sessionId) {
    if (!sessionId)
        return false;
    const header = readChannelHeader(dirs, channelId);
    if (!header || header.sessionId)
        return false; // already set or missing
    const filePath = channelPath(dirs, channelId);
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        if (lines.length === 0)
            return false;
        const meta = JSON.parse(lines[0]);
        meta.sessionId = sessionId;
        lines[0] = JSON.stringify(meta);
        const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
        fs.writeFileSync(tmp, lines.join('\n'));
        fs.renameSync(tmp, filePath);
        return true;
    }
    catch {
        return false;
    }
}
export function ensureNamedChannel(dirs, channelId, createdBy, description) {
    const normalized = normalizeChannelId(channelId);
    const existing = getChannel(dirs, normalized);
    if (existing)
        return existing;
    return writeChannel(dirs, {
        id: normalized,
        type: 'named',
        createdAt: new Date().toISOString(),
        createdBy,
        description,
    });
}
export function ensureDefaultNamedChannels(dirs, createdBy) {
    return DEFAULT_NAMED_CHANNELS.map((channel) => ensureNamedChannel(dirs, channel.id, createdBy, channel.description));
}
function toKebabCase(value) {
    return value
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .toLowerCase();
}
function allocateSessionChannelId(dirs, baseId) {
    const normalizedBase = normalizeChannelId(baseId);
    if (!getChannel(dirs, normalizedBase))
        return normalizedBase;
    for (let i = 2; i <= 99; i++) {
        const candidate = `${normalizedBase}-${i}`;
        if (!getChannel(dirs, candidate))
            return candidate;
    }
    const suffix = Math.random().toString(36).slice(2, 6);
    return `${normalizedBase}-${suffix}`;
}
export function generateSessionChannelId() {
    const generated = generateMemorableName();
    return toKebabCase(generated);
}
export function findChannelBySessionId(dirs, sessionId) {
    if (!sessionId)
        return null;
    for (const channel of listChannels(dirs)) {
        if (channel.type === 'session' && channel.sessionId === sessionId)
            return channel;
    }
    return null;
}
export function createSessionChannel(dirs, sessionId, createdBy) {
    return writeChannel(dirs, {
        id: allocateSessionChannelId(dirs, generateSessionChannelId()),
        type: 'session',
        createdAt: new Date().toISOString(),
        createdBy,
        sessionId,
    });
}
export function ensureSessionChannel(dirs, sessionId, createdBy) {
    if (sessionId) {
        const existing = findChannelBySessionId(dirs, sessionId);
        if (existing)
            return existing;
    }
    return createSessionChannel(dirs, sessionId, createdBy);
}
export function ensureExistingOrCreateChannel(dirs, channelId, options) {
    const normalized = normalizeChannelId(channelId);
    if (!isValidChannelId(normalized))
        return null;
    const existing = getChannel(dirs, normalized);
    if (existing)
        return existing;
    if (DEFAULT_NAMED_CHANNELS.some((channel) => channel.id === normalized)) {
        const preset = DEFAULT_NAMED_CHANNELS.find((channel) => channel.id === normalized);
        return ensureNamedChannel(dirs, normalized, options?.createdBy, preset.description);
    }
    if (!options?.create)
        return null;
    if (isSessionChannelId(normalized)) {
        return writeChannel(dirs, {
            id: normalized,
            type: 'session',
            createdAt: new Date().toISOString(),
            createdBy: options.createdBy,
            description: options.description,
        });
    }
    return ensureNamedChannel(dirs, normalized, options.createdBy, options.description);
}
