import * as fs from 'node:fs';
import * as path from 'node:path';
import { isProcessAlive } from '../../lib.js';
import { logFeedEvent } from '../../feed/index.js';
import { appendTaskEvent } from './events.js';
import { replayTasks } from './events.js';
import { findSpawnedAgentByName } from '../spawn.js';
import { getMessengerBase } from '../../store/shared.js';

/**
 * Check if an agent is active based on registry file and PID.
 * Returns: true (active), false (crashed/dead), null (unknown/no registry)
 */
function isAgentActive(cwd: string, agentName: string): boolean | null {
  const regPath = path.join(getMessengerBase(cwd), 'registry', `${agentName}.json`);
  if (!fs.existsSync(regPath)) return null;

  try {
    const reg = JSON.parse(fs.readFileSync(regPath, 'utf-8'));
    if (!reg.pid || !isProcessAlive(reg.pid)) return false;
    return true;
  } catch {
    return null;
  }
}

/**
 * Does a spawn record vouch for this agent? A spawned agent that the spawn
 * subsystem still considers `running` (and, if it has a pid, whose process is
 * alive) should not be treated as departed just because its registry file is
 * momentarily missing during the boot handshake.
 */
function isSpawnedAgentVouchedFor(cwd: string, sessionId: string, agentName: string): boolean {
  const spawned = findSpawnedAgentByName(cwd, sessionId, agentName);
  if (!spawned) return false;
  if (spawned.status !== 'running') return false;
  if (spawned.pid && !isProcessAlive(spawned.pid)) return false;
  return true;
}

/**
 * Clean up stale task claims from crashed or departed agents.
 * Returns the number of claims that were cleaned up.
 */
export function cleanupStaleTaskClaims(cwd: string, sessionId: string): number {
  const registryDir = path.join(getMessengerBase(cwd), 'registry');
  if (!fs.existsSync(registryDir)) return 0;

  // Use replayTasks directly instead of getTasks to avoid triggering cleanup recursively
  const tasks = replayTasks(cwd, sessionId);
  let cleaned = 0;

  const knownAgents = fs.existsSync(registryDir)
    ? fs
        .readdirSync(registryDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -5))
    : [];

  for (const task of tasks) {
    if (task.status !== 'in_progress' || !task.claimed_by) continue;

    const claimant = task.claimed_by;

    // Spawn-handshake protection: if the spawn subsystem still vouches for
    // this agent as running (its spawn record is `running` and, if it has a
    // pid, that process is alive), do not unclaim — the registry file may
    // simply not have landed yet. This is the window that previously caused
    // the spurious "agent left - task auto-unclaimed" race that lost claims
    // for actively-running spawned workers.
    const vouched = isSpawnedAgentVouchedFor(cwd, sessionId, claimant);

    const active = isAgentActive(cwd, claimant);
    if (active === false) {
      // Registry says the process is dead. Only skip cleanup if the spawn
      // subsystem still vouches for this agent (e.g. its spawn-record pid is
      // alive while the registry is stale/overwritten during a PID
      // transition). A pure time-based grace is intentionally NOT applied
      // here — a dead pid with no vouching spawn record is a real crash.
      if (vouched) continue;
      appendTaskEvent(cwd, sessionId, {
        taskId: task.id,
        type: 'released',
        timestamp: new Date().toISOString(),
        agent: claimant,
      });
      logFeedEvent(
        cwd,
        claimant,
        'task.reset',
        task.id,
        'agent crashed - task auto-unclaimed',
        task.channel ?? 'unknown'
      );
      cleaned++;
    } else if (active === null && knownAgents.length > 0) {
      // No readable registry file. Previously this was treated as "agent
      // left". But for a spawned agent still handshaking, the file is just
      // not written yet — not a departure. Only skip cleanup when the spawn
      // subsystem vouches for the agent; otherwise unclaim (genuinely
      // departed). The spawn record is written synchronously by spawnSubagent
      // before the worker claims, so vouching is reliable by claim time.
      if (vouched) continue;
      appendTaskEvent(cwd, sessionId, {
        taskId: task.id,
        type: 'released',
        timestamp: new Date().toISOString(),
        agent: claimant,
      });
      logFeedEvent(
        cwd,
        claimant,
        'task.reset',
        task.id,
        'agent left - task auto-unclaimed',
        task.channel ?? 'unknown'
      );
      cleaned++;
    }
  }

  return cleaned;
}
