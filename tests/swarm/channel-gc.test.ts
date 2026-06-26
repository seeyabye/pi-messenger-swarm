/**
 * Tests for orphaned-session-channel garbage collection
 * (store/channel-gc.ts → pruneOrphanedSessionChannels).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Dirs, MessengerState } from '../../lib.js';
import { CHANNEL_META_VERSION, listChannels } from '../../channel.js';
import { getLiveSessionIds, pruneOrphanedSessionChannels } from '../../store/channel-gc.js';

const roots = new Set<string>();

function createDirs(cwd: string): Dirs {
  const base = path.join(cwd, '.pi', 'messenger');
  const registry = path.join(base, 'registry');
  fs.mkdirSync(registry, { recursive: true });
  return { base, registry };
}

function createState(overrides: Partial<MessengerState> = {}): MessengerState {
  return {
    agentName: 'TestAgent',
    registered: true,
    watcher: null,
    watcherRetries: 0,
    watcherRetryTimer: null,
    watcherDebounceTimer: null,
    reservations: [],
    chatHistory: new Map(),
    unreadCounts: new Map(),
    channelPostHistory: [],
    seenSenders: new Map(),
    model: 'test-model',
    gitBranch: undefined,
    spec: undefined,
    scopeToFolder: false,
    isHuman: false,
    session: { toolCalls: 0, tokens: 0, filesModified: [] },
    activity: { lastActivityAt: new Date().toISOString() },
    statusMessage: undefined,
    customStatus: false,
    registryFlushTimer: null,
    sessionStartedAt: new Date().toISOString(),
    contextSessionId: 'test-session',
    currentChannel: 'test-channel',
    sessionChannel: 'test-channel',
    joinedChannels: ['test-channel', 'memory'],
    ...overrides,
  } as MessengerState;
}

function createChannelFile(dirs: Dirs, id: string, type: 'session' | 'named', sessionId?: string) {
  const channelsDir = path.join(dirs.base, 'channels');
  fs.mkdirSync(channelsDir, { recursive: true });
  const header = JSON.stringify({
    _meta: true,
    v: CHANNEL_META_VERSION,
    id,
    type,
    createdAt: new Date().toISOString(),
    sessionId,
  });
  fs.writeFileSync(path.join(channelsDir, `${id}.jsonl`), header + '\n');
}

function appendFeedEvent(dirs: Dirs, channelId: string) {
  const filePath = path.join(dirs.base, 'channels', `${channelId}.jsonl`);
  fs.appendFileSync(
    filePath,
    JSON.stringify({ ts: new Date().toISOString(), type: 'join', agent: 'someone' }) + '\n'
  );
}

function writeLiveSession(dirs: Dirs, sessionId: string) {
  fs.mkdirSync(path.join(dirs.base, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(dirs.base, 'sessions', String(process.pid)), sessionId);
}

afterEach(() => {
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function freshSetup() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-msg-gc-'));
  roots.add(cwd);
  return { cwd, dirs: createDirs(cwd), state: createState() };
}

describe('pruneOrphanedSessionChannels', () => {
  it('deletes header-only session channels with a dead session', () => {
    const { cwd, dirs, state } = freshSetup();
    createChannelFile(dirs, 'epic-xenon', 'session', 'dead-session-uuid');
    createChannelFile(dirs, 'gold-moon', 'session', 'another-dead-uuid');
    createChannelFile(dirs, 'memory', 'named');

    const res = pruneOrphanedSessionChannels(state, dirs, cwd);

    expect(res.deleted.sort()).toEqual(['epic-xenon', 'gold-moon']);
    // Named channels are not tracked in `kept`, but must remain on disk.
    expect(res.kept).toEqual([]);
    expect(listChannels(dirs).map((c) => c.id)).toEqual(['memory']);
  });

  it('never touches named channels', () => {
    const { cwd, dirs, state } = freshSetup();
    createChannelFile(dirs, 'pr35-regression', 'named'); // header-only named
    createChannelFile(dirs, 'memory', 'named');

    const res = pruneOrphanedSessionChannels(state, dirs, cwd);

    expect(res.deleted).toEqual([]);
    expect(
      listChannels(dirs)
        .map((c) => c.id)
        .sort()
    ).toEqual(['memory', 'pr35-regression']);
  });

  it('keeps session channels with feed history', () => {
    const { cwd, dirs, state } = freshSetup();
    createChannelFile(dirs, 'mint-phoenix', 'session', 'dead-session-uuid');
    appendFeedEvent(dirs, 'mint-phoenix');

    const res = pruneOrphanedSessionChannels(state, dirs, cwd);

    expect(res.deleted).toEqual([]);
    expect(res.kept).toEqual(['mint-phoenix']);
  });

  it('keeps session channels whose session is still live', () => {
    const { cwd, dirs, state } = freshSetup();
    writeLiveSession(dirs, 'live-session-uuid');
    createChannelFile(dirs, 'iron-tiger', 'session', 'live-session-uuid');

    const res = pruneOrphanedSessionChannels(state, dirs, cwd);

    expect(res.deleted).toEqual([]);
    expect(res.kept).toEqual(['iron-tiger']);
    expect(getLiveSessionIds(dirs).has('live-session-uuid')).toBe(true);
  });

  it('keeps the current agent session even without a sessions/<pid> file (race safety)', () => {
    const { cwd, dirs, state } = freshSetup();
    // No sessions/ dir written — simulates the race where the session-id
    // file has not been persisted yet. currentSessionId must still protect it.
    createChannelFile(dirs, 'fresh-channel', 'session', 'current-session-uuid');

    const res = pruneOrphanedSessionChannels(state, dirs, cwd, {
      currentSessionId: 'current-session-uuid',
    });

    expect(res.deleted).toEqual([]);
    expect(res.kept).toEqual(['fresh-channel']);
  });

  it('keeps session channels with an empty sessionId (cannot confirm dead)', () => {
    const { cwd, dirs, state } = freshSetup();
    createChannelFile(dirs, 'race-channel', 'session', undefined);

    const res = pruneOrphanedSessionChannels(state, dirs, cwd);

    expect(res.deleted).toEqual([]);
    expect(res.kept).toEqual(['race-channel']);
  });

  it('dryRun lists orphans without deleting', () => {
    const { cwd, dirs, state } = freshSetup();
    createChannelFile(dirs, 'epic-xenon', 'session', 'dead-session-uuid');

    const res = pruneOrphanedSessionChannels(state, dirs, cwd, { dryRun: true });

    expect(res.deleted).toEqual(['epic-xenon']);
    // file still exists on disk
    expect(listChannels(dirs).map((c) => c.id)).toEqual(['epic-xenon']);
  });
});
