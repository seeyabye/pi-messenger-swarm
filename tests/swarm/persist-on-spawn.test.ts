/**
 * Regression test: a successful spawn persists runtimes immediately, so a
 * harness crash in the window before the 15s periodic timer still recovers
 * the agent (closing the multi-project crash-recovery gap).
 *
 * The harness server persists on spawn via persistRuntimes(startupDirs.base).
 * We exercise persistRuntimes + restoreRuntimes directly: spawn an agent,
 * persist, clear in-memory state (simulating a crash), then restore and
 * confirm the agent is reattached from the snapshot.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ spawn: spawnMock }));

vi.mock('../../swarm/progress.js', () => ({
  createProgress: () => ({ tokens: 0, toolCallCount: 0, recentTools: [], status: 'running' }),
  updateProgress: () => {},
}));
vi.mock('../../swarm/live-progress.js', () => ({
  removeLiveWorker: () => {},
  updateLiveWorker: () => {},
}));

import {
  spawnSubagent,
  persistRuntimes,
  restoreRuntimes,
  clearSpawnStateForTests,
  clearPersistedRuntimes,
  getRunningSpawnCount,
} from '../../swarm/spawn.js';

const roots = new Set<string>();

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-messenger-persist-on-spawn-'));
  roots.add(dir);
  return dir;
}

afterEach(() => {
  clearSpawnStateForTests();
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  }
  roots.clear();
});

describe('persist-on-spawn crash recovery', () => {
  beforeEach(() => {
    clearSpawnStateForTests();
    // Fake a live child process so spawnSubagent's attached handlers don't crash.
    // Use the current process pid so the persisted runtime is "alive" on restore
    // (restoreRuntimes only reattaches entries whose pid is still live).
    spawnMock.mockImplementation(() => ({
      pid: process.pid,
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: () => {},
      kill: () => true,
      exitCode: null,
      signalCode: null,
    }));
  });

  it('a just-spawned agent survives a simulated crash via the persisted snapshot', () => {
    const projectCwd = tempDir();
    const messengerDir = path.join(projectCwd, '.pi', 'messenger');
    const sessionId = 'crash-window';

    // Spawn (adds to in-memory runtimes), then immediately persist — this is
    // what the harness server does on a successful 'spawn' action.
    const record = spawnSubagent(
      projectCwd,
      { role: 'Worker', objective: 'survive crash', message: 'survive crash' },
      sessionId,
      undefined,
      projectCwd
    );
    expect(record.pid).toBeTruthy();
    persistRuntimes(messengerDir);
    expect(fs.existsSync(path.join(messengerDir, 'spawn-runtimes.json'))).toBe(true);

    // Simulate a crash: lose all in-memory runtimes.
    clearSpawnStateForTests();
    expect(getRunningSpawnCount()).toBe(0);

    // Restore from the snapshot — the agent must be reattached.
    const restored = restoreRuntimes(messengerDir);
    expect(restored).toBe(1);
    expect(getRunningSpawnCount()).toBeGreaterThanOrEqual(1);

    clearPersistedRuntimes(messengerDir);
  });

  it('persistRuntimes removes the snapshot file when nothing is running', () => {
    const projectCwd = tempDir();
    const messengerDir = path.join(projectCwd, '.pi', 'messenger');
    fs.mkdirSync(messengerDir, { recursive: true });

    // No running runtimes → persist should clean up the file (not leave a stale snapshot).
    persistRuntimes(messengerDir);
    expect(fs.existsSync(path.join(messengerDir, 'spawn-runtimes.json'))).toBe(false);
  });
});
