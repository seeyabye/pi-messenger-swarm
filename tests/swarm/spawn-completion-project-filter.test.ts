/**
 * Regression test for the spawn-completion notification filter.
 *
 * The poll in index.ts (startSpawnCompletionPoll) reads spawn history and,
 * for each completed agent, decides whether to push a `spawn_completion`
 * notification. The original guard was:
 *
 *   if (agent.projectCwd && agent.projectCwd !== cwd) continue;
 *
 * where `cwd = normalizeCwd(process.cwd())` (the pi agent process cwd) and
 * `agent.projectCwd` was set at spawn time from the harness CLI caller's
 * `resolveProjectRoot(callerCwd())`. When the agent runs from a project
 * subdirectory, `process.cwd()` is the subdir while `projectCwd` is the
 * project root — the strict `!==` drops the completion and no notification
 * is ever delivered.
 *
 * This test asserts that `isSameProject` (the extracted helper) accepts the
 * subdir-vs-root case, and that the simulated filter decision — using the
 * helper — does not drop same-project completions.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isSameProject, normalizeCwd, resolveProjectRoot } from '../../store/shared.js';

const roots = new Set<string>();

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-messenger-proj-filter-'));
  roots.add(dir);
  return dir;
}

afterEach(() => {
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  }
  roots.clear();
});

/**
 * Re-encodes the filter decision the poll makes. Before the fix it was a
 * strict `projectCwd !== cwd`; after the fix it delegates to isSameProject.
 * This mirrors the index.ts logic without having to spin up the extension.
 */
function shouldNotify(agentProjectCwd: string | undefined, pollCwd: string): boolean {
  if (!agentProjectCwd) return true;
  // Fixed version: use isSameProject.
  return isSameProject(agentProjectCwd, pollCwd);
}

/**
 * The pre-fix guard: strict equality on the raw strings. Kept here to
 * document the regression — it must DROP the subdir case that the fixed
 * guard accepts. Polarity matches index.ts: `if (projectCwd && projectCwd
 * !== cwd) continue;` i.e. notify only when projectCwd === cwd.
 */
function oldStrictShouldNotify(agentProjectCwd: string | undefined, pollCwd: string): boolean {
  if (!agentProjectCwd) return true;
  return agentProjectCwd === normalizeCwd(pollCwd);
}

describe('spawn completion project filter', () => {
  it('notifies when agent runs from a project subdirectory and projectCwd is the root', () => {
    const root = tempDir();
    // Make it look like a project so resolveProjectRoot stops at `root`.
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    const subDir = path.join(root, 'src', 'deep');
    fs.mkdirSync(subDir, { recursive: true });

    const agentProjectCwd = root; // what the harness records (resolveProjectRoot)
    const pollCwd = subDir; // normalizeCwd(process.cwd()) inside the agent

    // Strict equality (the old guard) would skip this — that's the bug.
    expect(agentProjectCwd).not.toBe(normalizeCwd(pollCwd));

    // The fixed helper must recognise them as the same project.
    expect(isSameProject(agentProjectCwd, pollCwd)).toBe(true);
    expect(shouldNotify(agentProjectCwd, pollCwd)).toBe(true);

    // The OLD strict-equality guard would have dropped this — that's the bug.
    expect(oldStrictShouldNotify(agentProjectCwd, pollCwd)).toBe(false);
  });

  it('notifies when projectCwd equals poll cwd exactly', () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, '.pi'), { recursive: true });
    expect(shouldNotify(root, root)).toBe(true);
  });

  it('notifies when projectCwd is undefined (no project info recorded)', () => {
    const root = tempDir();
    expect(shouldNotify(undefined, root)).toBe(true);
  });

  it('does NOT notify for a genuinely different project', () => {
    const projectA = tempDir();
    fs.mkdirSync(path.join(projectA, '.git'), { recursive: true });
    const projectB = tempDir();
    fs.mkdirSync(path.join(projectB, '.git'), { recursive: true });

    expect(isSameProject(projectA, projectB)).toBe(false);
    expect(shouldNotify(projectA, projectB)).toBe(false);
  });

  it('resolveProjectRoot walks up to the nearest .git/.pi ancestor', () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, '.pi'), { recursive: true });
    const sub = path.join(root, 'packages', 'web');
    fs.mkdirSync(sub, { recursive: true });

    expect(resolveProjectRoot(sub)).toBe(root);
    expect(resolveProjectRoot(root)).toBe(root);
  });

  it('falls back to the start dir when no .git/.pi ancestor exists', () => {
    const orphan = tempDir();
    const sub = path.join(orphan, 'a', 'b');
    fs.mkdirSync(sub, { recursive: true });

    // No .git/.pi anywhere up the tree -> returns the start unchanged.
    expect(resolveProjectRoot(sub)).toBe(sub);
    // Two unrelated orphans are not the same project by root, but normalizeCwd
    // equality still gates isSameProject — confirm they differ.
    expect(isSameProject(orphan, sub)).toBe(false);
  });
});
