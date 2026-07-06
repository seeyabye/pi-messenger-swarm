/**
 * Worktree delegation regression test.
 *
 * Scenario: the main pi session runs in the project root. It delegates
 * workers into git worktrees (separate checkout directories that share the
 * repo's .git). Before the fix, store code derived paths with
 * `path.join(cwd, '.pi/messenger', ...)`, so a worker whose cwd was the
 * worktree wrote its spawn-event log, tasks, and feed into the worktree's
 * own `.pi/messenger/` — invisible to the main session's poll, which reads
 * the main project's `.pi/messenger/`. Notifications silently never fired.
 *
 * The fix: store path derivation now uses getMessengerBase(cwd), which
 * honors PI_MESSENGER_DIR (pinned by the extension to the main project's
 * harness server and inherited by every spawned agent) before falling back
 * to resolveProjectRoot(cwd)/.pi/messenger. So a worktree worker writes to
 * the main project's dir and the main session sees it.
 *
 * This test simulates the contract directly: with PI_MESSENGER_DIR set,
 * spawn-event and task paths resolve under the main project regardless of
 * whether cwd is the main repo or a worktree, and listSpawnedHistory from
 * the main project sees an event written by a worktree cwd.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getMessengerBase, normalizeCwd } from '../../store/shared.js';
import { getAgentEventsJsonlPath, loadSpawnedAgents } from '../../swarm/spawn.js';
import { getTasksJsonlPath } from '../../swarm/task-store/persistence.js';
import { logFeedEvent, readFeedEvents } from '../../feed/index.js';

const roots = new Set<string>();
let savedEnv: string | undefined;

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.add(dir);
  return dir;
}

beforeEach(() => {
  savedEnv = process.env.PI_MESSENGER_DIR;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.PI_MESSENGER_DIR;
  else process.env.PI_MESSENGER_DIR = savedEnv;
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  }
  roots.clear();
});

/** Create a real git repo with an initial commit and an attached worktree. */
function createRepoWithWorktree(): { main: string; worktree: string } {
  const main = tempDir('pi-messenger-wt-main-');
  // git init + a commit so worktree add works. Disable gpg signing for the
  // repo (some environments default to signing and have no secret key).
  execSync('git init -q', { cwd: main });
  execSync('git config user.email t@t.t', { cwd: main });
  execSync('git config user.name t', { cwd: main });
  execSync('git config commit.gpgsign false', { cwd: main });
  execSync('git commit --allow-empty -qm init', { cwd: main });

  const worktree = tempDir('pi-messenger-wt-tree-');
  // Remove the tempdir placeholder so `git worktree add` can create it.
  fs.rmSync(worktree, { recursive: true, force: true });
  execSync(`git worktree add -q "${worktree}"`, { cwd: main });

  roots.add(worktree);
  return { main, worktree };
}

describe('worktree delegation: shared messenger dir via cwd resolution', () => {
  it('getMessengerBase resolves a worktree cwd back to the main repo root', () => {
    const { main, worktree } = createRepoWithWorktree();
    const mainMessenger = path.join(normalizeCwd(main), '.pi', 'messenger');

    // No PI_MESSENGER_DIR env pin — resolution is purely cwd-based now.
    delete process.env.PI_MESSENGER_DIR;

    // From the main repo cwd
    expect(getMessengerBase(main)).toBe(mainMessenger);
    // From the worktree cwd — the worktree's `.git` is a *file* (gitdir
    // pointer). resolveProjectRoot follows it back to the main repo root so
    // the base is the main project's .pi/messenger, not a worktree-local one.
    expect(getMessengerBase(worktree)).toBe(mainMessenger);
    expect(getMessengerBase(worktree)).not.toContain('wt-tree');
  });

  it('spawn-event log for a worktree cwd lands in the main project dir', () => {
    const { main, worktree } = createRepoWithWorktree();
    const mainMessenger = path.join(normalizeCwd(main), '.pi', 'messenger');
    delete process.env.PI_MESSENGER_DIR;

    const sessionId = 'worktree-session';
    // Worker cwd is the worktree; event should still be written under main.
    const eventsPath = getAgentEventsJsonlPath(worktree, sessionId);
    expect(eventsPath.startsWith(mainMessenger)).toBe(true);
    expect(eventsPath.startsWith(path.join(normalizeCwd(worktree), '.pi', 'messenger'))).toBe(
      false
    );

    // Write a spawn event using the worktree cwd and confirm the main
    // project's loadSpawnedAgents observes it. We write the JSONL line
    // directly at the resolved path (the contract the fix enforces) rather
    // than calling the private appendEvent helper.
    fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
    fs.appendFileSync(
      eventsPath,
      JSON.stringify({
        id: 'wt-agent-1',
        type: 'spawned',
        timestamp: new Date().toISOString(),
        agent: {
          id: 'wt-agent-1',
          cwd: worktree,
          name: 'Worker',
          role: 'Subagent',
          status: 'running',
          startedAt: new Date().toISOString(),
          sessionId,
        },
      }) + '\n',
      'utf-8'
    );

    // Main session reads from its own cwd — must see the worktree agent.
    const seen = loadSpawnedAgents(main, sessionId);
    expect(seen.find((a) => a.id === 'wt-agent-1')).toBeTruthy();
    expect(seen.find((a) => a.id === 'wt-agent-1')?.name).toBe('Worker');
  });

  it('task paths for a worktree cwd land in the main project dir', () => {
    const { main, worktree } = createRepoWithWorktree();
    const mainMessenger = path.join(normalizeCwd(main), '.pi', 'messenger');
    delete process.env.PI_MESSENGER_DIR;

    const sessionId = 'worktree-session';
    const taskPath = getTasksJsonlPath(worktree, sessionId);
    expect(taskPath.startsWith(mainMessenger)).toBe(true);
    expect(taskPath.startsWith(path.join(normalizeCwd(worktree), '.pi', 'messenger'))).toBe(false);
  });

  it('feed events posted from a worktree cwd land in the main project channel file', () => {
    const { main, worktree } = createRepoWithWorktree();
    const mainMessenger = path.join(normalizeCwd(main), '.pi', 'messenger');
    delete process.env.PI_MESSENGER_DIR;

    const channelId = 'memory';
    // Ensure the named channel exists (metadata header) under the main dir.
    const channelsDir = path.join(mainMessenger, 'channels');
    fs.mkdirSync(channelsDir, { recursive: true });
    const channelFile = path.join(channelsDir, `${channelId}.jsonl`);
    fs.writeFileSync(
      channelFile,
      JSON.stringify({
        _meta: true,
        v: 1,
        id: channelId,
        type: 'named',
        createdAt: new Date().toISOString(),
      }) + '\n'
    );

    // A worker in the worktree posts a feed event.
    logFeedEvent(worktree, 'Worker', 'message', undefined, 'hello from worktree', channelId);

    // The main session reads the feed and sees the worktree worker's event.
    const events = readFeedEvents(main, 10, channelId);
    const ours = events.filter((e) => e.agent === 'Worker' && e.preview === 'hello from worktree');
    expect(ours.length).toBe(1);
  });

  it('PI_MESSENGER_DIR env no longer overrides cwd-based resolution (server pin is ignored)', () => {
    // The store code runs server-side, where process.env.PI_MESSENGER_DIR is
    // the shared harness server's startup pin — belonging to whichever
    // session started it, NOT necessarily the requesting project. Honoring
    // it would route every project's state into the server-startup project.
    // getMessengerBase now resolves from cwd (worktree-aware) and ignores
    // the env pin, so a stale/foreign pin cannot fragment state.
    const { main, worktree } = createRepoWithWorktree();
    const foreignDir = path.join(tempDir('pi-messenger-foreign-'), '.pi', 'messenger');
    process.env.PI_MESSENGER_DIR = foreignDir;

    expect(getMessengerBase(main)).toBe(path.join(normalizeCwd(main), '.pi', 'messenger'));
    expect(getMessengerBase(worktree)).toBe(path.join(normalizeCwd(main), '.pi', 'messenger'));
    expect(getMessengerBase(worktree)).not.toBe(foreignDir);
  });
});
