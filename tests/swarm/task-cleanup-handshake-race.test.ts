/**
 * Regression test for the spawn-handshake race in cleanupStaleTaskClaims.
 *
 * Scenario: a spawned agent claims a task during its boot handshake. Its
 * registry file has not been written yet (the agent is still registering).
 * A concurrent `getTasks` (throttled cleanup) must NOT auto-unclaim the
 * task, because the spawn subsystem still vouches for the agent as running.
 *
 * Previously, the "agent left - task auto-unclaimed" branch fired on the
 * missing registry file (`active === null`), losing the claim while the
 * agent continued executing.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

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
  clearSpawnStateForTests,
  findSpawnedAgentByName,
} from '../../swarm/spawn.js';
import * as taskStore from '../../swarm/task-store.js';

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = process.pid; // alive — vouches for the spawned agent
  exitCode: number | null = null;
  kill = vi.fn();
}

const roots = new Set<string>();

function createTempCwd(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-msg-handshake-race-'));
  roots.add(cwd);
  return cwd;
}

afterEach(() => {
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  roots.clear();
  clearSpawnStateForTests();
});

describe('cleanupStaleTaskClaims — spawn-handshake race', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('does NOT unclaim a task whose spawned agent has no registry file yet (handshake window)', () => {
    const cwd = createTempCwd();
    const sessionId = 'race-session';
    const agentName = 'QuickViper';

    // Registry dir exists (so knownAgents.length > 0 would be true if any file existed),
    // but the spawned agent's registry file is NOT written yet — simulating the
    // window between spawn/claim and the worker's register() writing registry/<name>.json.
    const registryDir = path.join(cwd, '.pi', 'messenger', 'registry');
    fs.mkdirSync(registryDir, { recursive: true });

    // A *different* live agent's registry exists, so knownAgents.length > 0
    // (this is the condition that previously triggered the "agent left" branch).
    fs.writeFileSync(
      path.join(registryDir, 'Coordinator.json'),
      JSON.stringify({ name: 'Coordinator', pid: process.pid, sessionId, cwd }, null, 2)
    );

    // Spawn a worker (status: running, pid: process.pid -> alive -> vouched for)
    const proc = new FakeProcess();
    spawnMock.mockReturnValue(proc as any);
    spawnSubagent(
      cwd,
      { role: 'Worker', objective: 'do work', name: agentName, taskId: 'task-1' },
      sessionId
    );

    // The worker claims a task.
    const task = taskStore.createTask(
      cwd,
      sessionId,
      { title: 'Gate checks', createdBy: 'Coordinator' },
      'iron-tiger'
    );
    taskStore.claimTask(cwd, sessionId, task.id, agentName);

    // Sanity: claim recorded, registry file for the worker is still absent.
    expect(taskStore.getTask(cwd, sessionId, task.id)?.claimed_by).toBe(agentName);
    expect(fs.existsSync(path.join(registryDir, `${agentName}.json`))).toBe(false);

    // The spawn record vouches for the agent as running.
    const vouch = findSpawnedAgentByName(cwd, sessionId, agentName);
    expect(vouch).not.toBeNull();
    expect(vouch?.status).toBe('running');

    // Force cleanup (bypass the 5s throttle) — this is the race moment.
    taskStore._resetCleanupThrottle(cwd, sessionId);
    taskStore.getTasks(cwd, sessionId);

    // The claim MUST survive: the spawn record vouches for the agent.
    const after = taskStore.getTask(cwd, sessionId, task.id);
    expect(after?.status).toBe('in_progress');
    expect(after?.claimed_by).toBe(agentName);
  });

  it('still unclaims when a non-spawned agent genuinely left (registry removed, no spawn record)', () => {
    const cwd = createTempCwd();
    const sessionId = 'leave-session';
    const departed = 'DepartedAgent';

    const registryDir = path.join(cwd, '.pi', 'messenger', 'registry');
    fs.mkdirSync(registryDir, { recursive: true });
    // A live coordinator exists so knownAgents.length > 0.
    fs.writeFileSync(
      path.join(registryDir, 'Coordinator.json'),
      JSON.stringify({ name: 'Coordinator', pid: process.pid, sessionId, cwd }, null, 2)
    );

    const task = taskStore.createTask(
      cwd,
      sessionId,
      { title: 'orphaned claim', createdBy: 'Coordinator' },
      'iron-tiger'
    );
    taskStore.claimTask(cwd, sessionId, task.id, departed);
    // No registry file for `departed`, and no spawn record — genuinely left.

    taskStore._resetCleanupThrottle(cwd, sessionId);
    taskStore.getTasks(cwd, sessionId);

    // Genuinely-departed agent (no vouch) is cleaned up.
    const after = taskStore.getTask(cwd, sessionId, task.id);
    expect(after?.status).toBe('todo');
    expect(after?.claimed_by).toBeUndefined();
  });

  it('still unclaims a spawned agent whose spawn-record process is dead (no claim leak)', () => {
    const cwd = createTempCwd();
    const sessionId = 'dead-spawn-session';
    const agentName = 'DeadWorker';

    const registryDir = path.join(cwd, '.pi', 'messenger', 'registry');
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, 'Coordinator.json'),
      JSON.stringify({ name: 'Coordinator', pid: process.pid, sessionId, cwd }, null, 2)
    );

    // Spawn a worker with a DEAD pid (99999) — spawn record marks it running,
    // but its process is not alive. The vouch must fail so the claim is released.
    const proc = new FakeProcess();
    (proc as any).pid = 99999; // non-existent process
    spawnMock.mockReturnValue(proc as any);
    spawnSubagent(
      cwd,
      { role: 'Worker', objective: 'do work', name: agentName, taskId: 'task-1' },
      sessionId
    );

    const task = taskStore.createTask(
      cwd,
      sessionId,
      { title: 'leak guard', createdBy: 'Coordinator' },
      'iron-tiger'
    );
    taskStore.claimTask(cwd, sessionId, task.id, agentName);

    taskStore._resetCleanupThrottle(cwd, sessionId);
    taskStore.getTasks(cwd, sessionId);

    // Spawn record exists & running, but its pid is dead → not vouched → unclaimed.
    const after = taskStore.getTask(cwd, sessionId, task.id);
    expect(after?.status).toBe('todo');
    expect(after?.claimed_by).toBeUndefined();
  });

  it('preserves a claim when the spawn-record pid is alive but the registry pid is dead (stale registry)', () => {
    const cwd = createTempCwd();
    const sessionId = 'stale-registry-session';
    const agentName = 'StaleRegWorker';

    const registryDir = path.join(cwd, '.pi', 'messenger', 'registry');
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, 'Coordinator.json'),
      JSON.stringify({ name: 'Coordinator', pid: process.pid, sessionId, cwd }, null, 2)
    );

    // Spawn record pid = process.pid (alive) → vouched.
    const proc = new FakeProcess();
    spawnMock.mockReturnValue(proc as any);
    spawnSubagent(
      cwd,
      { role: 'Worker', objective: 'do work', name: agentName, taskId: 'task-1' },
      sessionId
    );

    const task = taskStore.createTask(
      cwd,
      sessionId,
      { title: 'stale registry guard', createdBy: 'Coordinator' },
      'iron-tiger'
    );
    taskStore.claimTask(cwd, sessionId, task.id, agentName);

    // Write a registry for the worker with a DEAD pid — simulating the PID
    // transition where the registry briefly records a stale (dead) pid while
    // the spawn subsystem knows the real live pid.
    fs.writeFileSync(
      path.join(registryDir, `${agentName}.json`),
      JSON.stringify({ name: agentName, pid: 99999, sessionId, cwd }, null, 2)
    );

    taskStore._resetCleanupThrottle(cwd, sessionId);
    taskStore.getTasks(cwd, sessionId);

    // Vouched by the spawn record (live pid) → claim preserved despite the
    // stale dead-pid registry.
    const after = taskStore.getTask(cwd, sessionId, task.id);
    expect(after?.status).toBe('in_progress');
    expect(after?.claimed_by).toBe(agentName);
  });
});
