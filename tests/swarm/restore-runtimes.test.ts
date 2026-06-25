/**
 * Regression tests for multi-project crash recovery via restoreRuntimes.
 *
 * persistRuntimes writes ALL in-memory runtimes (across every project the
 * harness serves) to one spawn-runtimes.json. On restart, restoreRuntimes
 * reattaches entries whose PID is still alive and — the fix tested here —
 * writes a 'failed' tombstone for entries whose process died between the
 * persist and the restore, so their event log isn't stuck at 'running'.
 * It must not override a legitimate terminal event the old server wrote.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('../../swarm/progress.js', () => ({
  createProgress: () => ({ tokens: 0, toolCallCount: 0, recentTools: [], status: 'running' }),
  updateProgress: () => {},
}));
vi.mock('../../swarm/live-progress.js', () => ({
  removeLiveWorker: () => {},
  updateLiveWorker: () => {},
}));

import {
  restoreRuntimes,
  listSpawnedHistory,
  getRunningSpawnCount,
  clearSpawnStateForTests,
} from '../../swarm/spawn.js';
import type { SpawnedAgent } from '../../swarm/types.js';

const roots = new Set<string>();
const DEAD_PID = 4194304; // max-ish PID; guaranteed not alive

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-messenger-restore-'));
  roots.add(dir);
  return dir;
}

function agentEventsPath(cwd: string, sessionId: string): string {
  return path.join(cwd, '.pi', 'messenger', 'agents', `${sessionId}.jsonl`);
}

function writeSpawnedEvent(cwd: string, sessionId: string, agent: SpawnedAgent): void {
  const filePath = agentEventsPath(cwd, sessionId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(
    filePath,
    JSON.stringify({ id: agent.id, type: 'spawned', timestamp: agent.startedAt, agent }) + '\n',
    'utf-8'
  );
}

function writeRuntimesFile(messengerDir: string, entries: Array<Record<string, unknown>>): void {
  fs.mkdirSync(messengerDir, { recursive: true });
  fs.writeFileSync(
    path.join(messengerDir, 'spawn-runtimes.json'),
    JSON.stringify(entries, null, 2)
  );
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

describe('restoreRuntimes — crash recovery tombstones', () => {
  beforeEach(() => {
    clearSpawnStateForTests();
  });

  it('writes a failed tombstone for a persisted runtime whose PID is dead', () => {
    const projectCwd = tempDir();
    const messengerDir = path.join(projectCwd, '.pi', 'messenger');
    const sessionId = 'restore-dead';
    const startedAt = new Date().toISOString();

    const record: SpawnedAgent = {
      id: 'dead-1',
      cwd: projectCwd,
      name: 'DeadAgent',
      role: 'Worker',
      objective: 'die',
      status: 'running',
      startedAt,
      sessionId,
      pid: DEAD_PID,
    };
    writeSpawnedEvent(projectCwd, sessionId, record);
    writeRuntimesFile(messengerDir, [
      { id: record.id, pid: DEAD_PID, record, startMs: Date.now() },
    ]);

    const restored = restoreRuntimes(messengerDir);
    expect(restored).toBe(0); // nothing alive to reattach

    const agents = listSpawnedHistory(projectCwd, sessionId);
    const dead = agents.find((a) => a.id === 'dead-1');
    expect(dead?.status).toBe('failed');
    expect(dead?.error).toContain('runtime restore');
    expect(dead?.endedAt).toBeDefined();
  });

  it('does not override a legitimate terminal event', () => {
    const projectCwd = tempDir();
    const messengerDir = path.join(projectCwd, '.pi', 'messenger');
    const sessionId = 'restore-completed';
    const startedAt = new Date().toISOString();

    const record: SpawnedAgent = {
      id: 'done-1',
      cwd: projectCwd,
      name: 'DoneAgent',
      role: 'Worker',
      objective: 'done',
      status: 'running',
      startedAt,
      sessionId,
      pid: DEAD_PID,
    };
    writeSpawnedEvent(projectCwd, sessionId, record);
    // Old server already wrote a 'completed' terminal event before exiting.
    const filePath = agentEventsPath(projectCwd, sessionId);
    fs.appendFileSync(
      filePath,
      JSON.stringify({
        id: 'done-1',
        type: 'completed',
        timestamp: new Date().toISOString(),
        agent: { status: 'completed', endedAt: new Date().toISOString(), exitCode: 0 },
      }) + '\n',
      'utf-8'
    );
    writeRuntimesFile(messengerDir, [
      { id: record.id, pid: DEAD_PID, record, startMs: Date.now() },
    ]);

    restoreRuntimes(messengerDir);

    const done = listSpawnedHistory(projectCwd, sessionId).find((a) => a.id === 'done-1');
    expect(done?.status).toBe('completed'); // not overwritten with 'failed'
  });

  it('reattaches a persisted runtime whose PID is still alive', () => {
    const projectCwd = tempDir();
    const messengerDir = path.join(projectCwd, '.pi', 'messenger');
    const sessionId = 'restore-alive';
    const startedAt = new Date().toISOString();

    const record: SpawnedAgent = {
      id: 'alive-1',
      cwd: projectCwd,
      name: 'AliveAgent',
      role: 'Worker',
      objective: 'live',
      status: 'running',
      startedAt,
      sessionId,
      pid: process.pid, // this test process is alive
    };
    writeSpawnedEvent(projectCwd, sessionId, record);
    writeRuntimesFile(messengerDir, [
      { id: record.id, pid: process.pid, record, startMs: Date.now() },
    ]);

    const restored = restoreRuntimes(messengerDir);
    expect(restored).toBe(1);
    expect(getRunningSpawnCount()).toBeGreaterThanOrEqual(1);
  });

  it('handles a mix of dead and alive across projects in one file', () => {
    const projectA = tempDir();
    const projectB = tempDir();
    const messengerDir = path.join(projectA, '.pi', 'messenger');
    const startedAt = new Date().toISOString();

    const deadRecord: SpawnedAgent = {
      id: 'dead-a',
      cwd: projectA,
      name: 'DeadA',
      role: 'Worker',
      objective: 'a',
      status: 'running',
      startedAt,
      sessionId: 'sess-a',
      pid: DEAD_PID,
    };
    const aliveRecord: SpawnedAgent = {
      id: 'alive-b',
      cwd: projectB,
      name: 'AliveB',
      role: 'Worker',
      objective: 'b',
      status: 'running',
      startedAt,
      sessionId: 'sess-b',
      pid: process.pid,
    };
    writeSpawnedEvent(projectA, 'sess-a', deadRecord);
    writeSpawnedEvent(projectB, 'sess-b', aliveRecord);
    writeRuntimesFile(messengerDir, [
      { id: deadRecord.id, pid: DEAD_PID, record: deadRecord, startMs: Date.now() },
      { id: aliveRecord.id, pid: process.pid, record: aliveRecord, startMs: Date.now() },
    ]);

    const restored = restoreRuntimes(messengerDir);
    expect(restored).toBe(1); // only the alive one reattached

    // Dead one in project A got a tombstone (multi-project recovery)
    const deadA = listSpawnedHistory(projectA, 'sess-a').find((a) => a.id === 'dead-a');
    expect(deadA?.status).toBe('failed');
  });
});
