/**
 * Tests for `channel prune` / `channel delete` actions and for the
 * no-orphan-mint behavior of spawned subagents inheriting a parent channel.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Dirs, MessengerState } from '../../lib.js';
import { executeAction } from '../../router.js';
import { createMockContext } from '../helpers/mock-context.js';
import * as store from '../../store.js';
import { CHANNEL_META_VERSION, listChannels } from '../../channel.js';

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

function writeLiveAgentRegistration(dirs: Dirs, name: string, channel: string) {
  fs.writeFileSync(
    path.join(dirs.registry, `${name}.json`),
    JSON.stringify(
      {
        name,
        pid: process.pid,
        sessionId: 'test-session',
        cwd: process.cwd(),
        model: 'test-model',
        startedAt: new Date().toISOString(),
        isHuman: false,
        session: { toolCalls: 0, tokens: 0, filesModified: [] },
        activity: { lastActivityAt: new Date().toISOString() },
        currentChannel: channel,
        sessionChannel: channel,
        joinedChannels: [channel, 'memory'],
      },
      null,
      2
    )
  );
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
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-msg-ops-'));
  roots.add(cwd);
  return { cwd, dirs: createDirs(cwd), state: createState() };
}

async function run(
  action: string,
  params: Record<string, unknown>,
  state: MessengerState,
  dirs: Dirs,
  cwd: string
) {
  return executeAction(
    action,
    params,
    state,
    dirs,
    createMockContext(cwd),
    () => {},
    () => {}
  );
}

describe('channel.prune', () => {
  it('dry-run lists orphans without deleting', async () => {
    const { cwd, dirs, state } = freshSetup();
    createChannelFile(dirs, 'epic-xenon', 'session', 'dead-session-uuid');
    createChannelFile(dirs, 'memory', 'named');

    const res = await run('channel.prune', { dryRun: true }, state, dirs, cwd);

    expect(res.details.mode).toBe('channel.prune');
    expect(res.details.dryRun).toBe(true);
    expect(res.details.deleted).toEqual(['epic-xenon']);
    // still on disk
    expect(
      listChannels(dirs)
        .map((c) => c.id)
        .sort()
    ).toEqual(['epic-xenon', 'memory']);
  });

  it('removes orphaned session channels', async () => {
    const { cwd, dirs, state } = freshSetup();
    createChannelFile(dirs, 'epic-xenon', 'session', 'dead-session-uuid');
    createChannelFile(dirs, 'gold-moon', 'session', 'another-dead-uuid');

    const res = await run('channel.prune', {}, state, dirs, cwd);

    expect(res.details.deleted.sort()).toEqual(['epic-xenon', 'gold-moon']);
    expect(listChannels(dirs).map((c) => c.id)).toEqual([]);
  });
});

describe('channel.delete', () => {
  it('refuses to delete #memory (protected)', async () => {
    const { cwd, dirs, state } = freshSetup();
    const res = await run('channel.delete', { channel: 'memory' }, state, dirs, cwd);
    expect(res.details.error).toBe('protected');
    expect(res.content[0].text).toMatch(/protected/);
  });

  it('errors when channel not found', async () => {
    const { cwd, dirs, state } = freshSetup();
    const res = await run('channel.delete', { channel: 'nope' }, state, dirs, cwd);
    expect(res.details.error).toBe('not_found');
  });

  it('errors when a live agent is joined', async () => {
    const { cwd, dirs, state } = freshSetup();
    createChannelFile(dirs, 'pr35-regression', 'named');
    writeLiveAgentRegistration(dirs, 'OtherAgent', 'pr35-regression');

    const res = await run(
      'channel.delete',
      { channel: 'pr35-regression', force: true },
      state,
      dirs,
      cwd
    );
    expect(res.details.error).toBe('agents_joined');
    expect(listChannels(dirs).map((c) => c.id)).toContain('pr35-regression');
  });

  it('refuses to delete a channel with history unless --force', async () => {
    const { cwd, dirs, state } = freshSetup();
    createChannelFile(dirs, 'pr35-regression', 'named');
    appendFeedEvent(dirs, 'pr35-regression');

    const res = await run('channel.delete', { channel: 'pr35-regression' }, state, dirs, cwd);
    expect(res.details.error).toBe('has_history');
    expect(listChannels(dirs).map((c) => c.id)).toContain('pr35-regression');
  });

  it('deletes a channel with history when --force is given', async () => {
    const { cwd, dirs, state } = freshSetup();
    createChannelFile(dirs, 'pr35-regression', 'named');
    appendFeedEvent(dirs, 'pr35-regression');

    const res = await run(
      'channel.delete',
      { channel: 'pr35-regression', force: true },
      state,
      dirs,
      cwd
    );
    expect(res.details.mode).toBe('channel.delete');
    expect(res.details.channel).toBe('pr35-regression');
    expect(listChannels(dirs).map((c) => c.id)).not.toContain('pr35-regression');
  });

  it('refuses to delete a channel the current agent is joined to', async () => {
    const { cwd, dirs, state } = freshSetup();
    // state.joinedChannels = ['test-channel', 'memory'], currentChannel = 'test-channel'
    createChannelFile(dirs, 'test-channel', 'named');

    const res = await run(
      'channel.delete',
      { channel: 'test-channel', force: true },
      state,
      dirs,
      cwd
    );

    expect(res.details.error).toBe('self_joined');
    expect(listChannels(dirs).map((c) => c.id)).toContain('test-channel');
  });

  it('deletes an empty named channel without --force', async () => {
    const { cwd, dirs, state } = freshSetup();
    createChannelFile(dirs, 'pr35-regression', 'named');

    const res = await run('channel.delete', { channel: 'pr35-regression' }, state, dirs, cwd);
    expect(res.details.mode).toBe('channel.delete');
    expect(listChannels(dirs).map((c) => c.id)).not.toContain('pr35-regression');
  });
});

describe('spawned subagent inheriting an existing parent channel', () => {
  it('does not mint an orphan session channel (register-level)', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-msg-nomint-'));
    roots.add(cwd);
    const dirs = createDirs(cwd);

    // Parent already created its session channel on disk (with history).
    createChannelFile(dirs, 'iron-tiger', 'session', 'parent-session-uuid');
    appendFeedEvent(dirs, 'iron-tiger');

    // Child inherits the parent channel (resolveAgentState set currentChannel
    // from the x-messenger-channel header). Thread it as inheritedChannel.
    const state: MessengerState = {
      ...createState({ agentName: 'SpawnedChild' } as Partial<MessengerState>),
      registered: false,
      contextSessionId: 'child-session',
      currentChannel: 'iron-tiger',
      sessionChannel: 'iron-tiger',
      joinedChannels: ['iron-tiger', 'memory'],
    } as MessengerState;

    const ok = store.register(state, dirs, createMockContext(cwd), undefined, 'iron-tiger');

    expect(ok).toBe(true);
    // Child stays on the parent channel as its home — no orphan minted.
    expect(state.currentChannel).toBe('iron-tiger');
    expect(state.sessionChannel).toBe('iron-tiger');
    expect(
      listChannels(dirs)
        .map((c) => c.id)
        .sort()
    ).toEqual(['iron-tiger', 'memory']);
  });
});
