import * as fs from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { AgentRegistration, Dirs, MessengerState } from '../lib.js';
import { isProcessAlive } from '../lib.js';
import {
  MEMORY_CHANNEL_ID,
  ensureDefaultNamedChannels,
  ensureExistingOrCreateChannel,
  ensureSessionChannel,
  getChannel,
  normalizeChannelId,
} from '../channel.js';

export function ensureDirSync(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function normalizeCwd(cwd: string): string {
  try {
    return fs.realpathSync.native(cwd);
  } catch {
    return resolve(cwd);
  }
}

/**
 * Walk up from `start` to find the nearest ancestor containing `.git/` or
 * `.pi/`. Falls back to `start` itself. Mirrors the harness CLI's
 * `resolveProjectRoot` so the extension and harness agree on what counts as
 * "the same project" even when invoked from a subdirectory.
 */
export function resolveProjectRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(join(dir, '.git')) || fs.existsSync(join(dir, '.pi'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

/**
 * Returns true when two cwds belong to the same project. Compares the
 * resolved project roots (nearest `.git`/`.pi` ancestor), so an agent
 * running from a subdirectory still matches a spawn record whose projectCwd
 * is the project root. Falls back to normalized cwd equality when neither
 * path has a `.git`/`.pi` ancestor (e.g. ad-hoc temp dirs in tests).
 */
export function isSameProject(a: string, b: string): boolean {
  const na = normalizeCwd(a);
  const nb = normalizeCwd(b);
  if (na === nb) return true;
  const ra = resolveProjectRoot(na);
  const rb = resolveProjectRoot(nb);
  return ra === rb;
}

export function getGitBranch(cwd: string): string | undefined {
  try {
    const result = execSync('git branch --show-current', {
      cwd,
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (result) return result;

    const sha = execSync('git rev-parse --short HEAD', {
      cwd,
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    return sha ? `@${sha}` : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeJoinedChannels(
  channels: string[] | undefined,
  currentChannel?: string,
  sessionChannel?: string
): string[] {
  const set = new Set<string>();
  for (const channel of channels ?? []) {
    if (channel) set.add(normalizeChannelId(channel));
  }
  if (sessionChannel) set.add(normalizeChannelId(sessionChannel));
  if (currentChannel) set.add(normalizeChannelId(currentChannel));
  set.add(MEMORY_CHANNEL_ID);
  return Array.from(set);
}

export function keepNamedChannels(dirs: Dirs, channels: string[] | undefined): string[] {
  const kept = new Set<string>();
  for (const channel of channels ?? []) {
    if (!channel) continue;
    const normalized = normalizeChannelId(channel);
    const record = getChannel(dirs, normalized);
    if (record?.type === 'session') continue;
    kept.add(normalized);
  }
  return Array.from(kept);
}

export function getContextSessionId(ctx: ExtensionContext): string {
  try {
    return ctx.sessionManager.getSessionId?.() ?? '';
  } catch {
    return '';
  }
}

/**
 * Read a channel's sessionId from the project-scoped location.
 * Returns null if channel doesn't exist or has no sessionId.
 */
export function getProjectChannelSessionId(cwd: string, channelId: string): string | null {
  const normalized = normalizeChannelId(channelId);
  const channelPath = join(cwd, '.pi', 'messenger', 'channels', `${normalized}.jsonl`);
  try {
    if (!fs.existsSync(channelPath)) return null;
    const content = fs.readFileSync(channelPath, 'utf-8');
    const lines = content.split('\n');
    if (lines.length === 0) return null;
    const header = JSON.parse(lines[0]) as { _meta?: boolean; sessionId?: string };
    if (header._meta && header.sessionId) {
      return header.sessionId;
    }
  } catch {
    // Fall through
  }
  return null;
}

/**
 * Get the effective session ID for swarm operations.
 * Uses the current channel's stored sessionId if available,
 * otherwise falls back to the current pi context session.
 * This ensures all operations in a channel use consistent storage,
 * regardless of which pi process (parent or subagent) performs them.
 */
export function getEffectiveSessionId(cwd: string, state: MessengerState): string {
  const currentChannel = state.currentChannel ?? state.sessionChannel;
  if (currentChannel) {
    const channelSessionId = getProjectChannelSessionId(cwd, currentChannel);
    if (channelSessionId) {
      return channelSessionId;
    }
  }
  if (state.contextSessionId) {
    return state.contextSessionId;
  }
  // Disk-based fallback: read the session-id file written by the extension
  // during session_start. This ensures the poll works even when
  // autoRegister is false (state.currentChannel/contextSessionId not set).
  //
  // Prefer the per-pid entry (sessions/<process.pid>) so concurrent pi
  // sessions in the same project each resolve their own id; fall back to the
  // singleton. This runs in-process, so process.pid is the current session.
  try {
    const baseDir =
      process.env.PI_MESSENGER_DIR ||
      (process.env.PI_MESSENGER_GLOBAL === '1'
        ? join(getAgentDir(), 'messenger')
        : join(cwd, '.pi/messenger'));
    // Per-pid first (concurrent-session safe). A missing per-pid file is not
    // an error — swallow it so the singleton fallback below still runs.
    const perPidPath = join(baseDir, 'sessions', String(process.pid));
    try {
      const perPid = fs.readFileSync(perPidPath, 'utf-8').trim();
      if (perPid) return perPid;
    } catch {
      // no per-pid entry yet
    }
    const sessionFilePath = join(baseDir, 'session-id');
    const id = fs.readFileSync(sessionFilePath, 'utf-8').trim();
    if (id) return id;
  } catch {
    // File may not exist yet
  }
  return '';
}

export function ensureStateChannels(
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext,
  options?: { preserveNamedChannel?: boolean; inheritedChannel?: string }
): void {
  ensureDefaultNamedChannels(dirs, state.agentName || undefined);

  const envInherited = process.env.PI_MESSENGER_CHANNEL?.trim();
  const sessionId = getContextSessionId(ctx);
  // A channel the agent is inheriting from a parent (spawned subagents).
  // When set and already on disk, adopt it as the agent's home channel
  // instead of minting an orphaned session channel that would never be
  // posted to. Threaded from executeJoin via the x-messenger-channel header.
  const adoptedChannel = options?.inheritedChannel?.trim();

  let sessionChannel = state.sessionChannel?.trim();
  let resetToSessionChannel = false;
  if (envInherited) {
    const record = ensureExistingOrCreateChannel(dirs, envInherited, {
      create: true,
      createdBy: state.agentName || undefined,
    });
    sessionChannel = record?.id ?? normalizeChannelId(envInherited);
    resetToSessionChannel = true;
  } else if (adoptedChannel) {
    // Spawned subagent inheriting a parent channel: adopt the existing
    // channel as home (no orphan mint) only if it already exists on disk
    // (the parent always creates it first). If it doesn't exist yet, fall
    // through to minting so executeJoin's restore can create it.
    const existing = getChannel(dirs, normalizeChannelId(adoptedChannel));
    if (existing) {
      sessionChannel = existing.id;
      resetToSessionChannel = true;
    } else {
      sessionChannel = ensureSessionChannel(dirs, sessionId, state.agentName || undefined).id;
      resetToSessionChannel = true;
    }
  } else if (sessionId) {
    sessionChannel = ensureSessionChannel(dirs, sessionId, state.agentName || undefined).id;
    resetToSessionChannel = true;
  } else if (sessionChannel) {
    const record = ensureExistingOrCreateChannel(dirs, sessionChannel, {
      create: true,
      createdBy: state.agentName || undefined,
    });
    sessionChannel = record?.id ?? normalizeChannelId(sessionChannel);
  } else {
    sessionChannel = ensureSessionChannel(dirs, sessionId, state.agentName || undefined).id;
    resetToSessionChannel = true;
  }

  state.sessionChannel = normalizeChannelId(sessionChannel);

  if (resetToSessionChannel) {
    // When registering for the first time, preserve a valid named channel
    // the agent may have joined via CLI so the overlay opens on the right
    // channel. Skip this during session rebinding where we always want the
    // session channel. We check the actual channel record type on disk
    // rather than the ID pattern, because session channels use phrase IDs
    // that do not start with 'session-'.
    if (options?.preserveNamedChannel) {
      const current = state.currentChannel?.trim();
      const record = current ? getChannel(dirs, normalizeChannelId(current)) : null;
      const isValidNamed = record?.type === 'named';
      if (!isValidNamed) {
        state.currentChannel = state.sessionChannel;
      }
    } else {
      state.currentChannel = state.sessionChannel;
    }

    state.joinedChannels = normalizeJoinedChannels(
      keepNamedChannels(dirs, state.joinedChannels),
      state.currentChannel,
      state.sessionChannel
    );
    return;
  }

  let currentChannel = state.currentChannel?.trim();
  if (currentChannel) {
    const record = ensureExistingOrCreateChannel(dirs, currentChannel, {
      create: true,
      createdBy: state.agentName || undefined,
    });
    currentChannel = record?.id ?? normalizeChannelId(currentChannel);
  } else {
    currentChannel = state.sessionChannel;
  }

  state.currentChannel = normalizeChannelId(currentChannel);
  state.joinedChannels = normalizeJoinedChannels(
    state.joinedChannels,
    state.currentChannel,
    state.sessionChannel
  );
}

export function applyRegistrationDefaults(reg: AgentRegistration): AgentRegistration {
  const currentChannel = reg.currentChannel ? normalizeChannelId(reg.currentChannel) : undefined;
  const sessionChannel = reg.sessionChannel
    ? normalizeChannelId(reg.sessionChannel)
    : currentChannel;
  return {
    ...reg,
    session: reg.session ?? { toolCalls: 0, tokens: 0, filesModified: [] },
    activity: reg.activity ?? { lastActivityAt: reg.startedAt },
    isHuman: reg.isHuman ?? false,
    currentChannel: currentChannel ?? sessionChannel ?? undefined,
    sessionChannel,
    joinedChannels: normalizeJoinedChannels(reg.joinedChannels, currentChannel, sessionChannel),
  };
}

export function updateChannelsInRegistration(
  state: MessengerState,
  reg: AgentRegistration
): AgentRegistration {
  return {
    ...reg,
    currentChannel: state.currentChannel,
    sessionChannel: state.sessionChannel,
    joinedChannels: normalizeJoinedChannels(
      state.joinedChannels,
      state.currentChannel,
      state.sessionChannel
    ),
  };
}
