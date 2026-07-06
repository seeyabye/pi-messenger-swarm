/**
 * Unit tests for resolveProjectRoot's worktree awareness.
 *
 * A linked git worktree's `.git` is a *file* (a `gitdir:` pointer), not a
 * directory. Before the fix, resolveProjectRoot treated `fs.existsSync(.git)`
 * as "this is the project root" for both files and directories, so a worktree
 * cwd resolved to the worktree itself — fragmenting swarm state into a
 * worktree-local `.pi/messenger` the main session never reads.
 *
 * The fix follows the `gitdir:` pointer + `commondir` back to the main
 * repository root, so a worktree cwd resolves to its main repo.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeCwd, resolveProjectRoot } from '../../store/shared.js';

const roots = new Set<string>();

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

function createRepoWithWorktree(): { main: string; worktree: string } {
  const main = tempDir('pi-messenger-rpr-main-');
  execSync('git init -q', { cwd: main });
  execSync('git config user.email t@t.t', { cwd: main });
  execSync('git config user.name t', { cwd: main });
  execSync('git config commit.gpgsign false', { cwd: main });
  execSync('git commit --allow-empty -qm init', { cwd: main });

  const worktree = tempDir('pi-messenger-rpr-tree-');
  fs.rmSync(worktree, { recursive: true, force: true });
  execSync(`git worktree add -q "${worktree}"`, { cwd: main });
  roots.add(worktree);
  return { main, worktree };
}

describe('resolveProjectRoot — worktree awareness', () => {
  // In production every caller normalizes first (getMessengerBase does
  // normalizeCwd(cwd); the CLI passes resolveSessionCwd() which is a
  // realpath from lsof/readlink). Mirror that here so expectations are
  // symlink-stable on macOS (/var -> /private/var).
  const rp = (p: string) => normalizeCwd(p);

  it('resolves a worktree cwd to the main repository root', () => {
    const { main, worktree } = createRepoWithWorktree();
    // The worktree's .git is a file, not a directory.
    const gitStat = fs.statSync(path.join(worktree, '.git'));
    expect(gitStat.isFile()).toBe(true);

    expect(resolveProjectRoot(rp(worktree))).toBe(rp(main));
  });

  it('resolves a subdirectory of a worktree to the main repository root', () => {
    const { main, worktree } = createRepoWithWorktree();
    const sub = path.join(worktree, 'src', 'deep');
    fs.mkdirSync(sub, { recursive: true });

    expect(resolveProjectRoot(rp(sub))).toBe(rp(main));
  });

  it('resolves the main repo cwd to itself (no worktree indirection)', () => {
    const { main } = createRepoWithWorktree();
    expect(resolveProjectRoot(rp(main))).toBe(rp(main));
  });

  it('still stops at a normal repo (.git directory) without walking further', () => {
    const root = tempDir('pi-messenger-rpr-normal-');
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    const sub = path.join(root, 'packages', 'web');
    fs.mkdirSync(sub, { recursive: true });

    expect(resolveProjectRoot(rp(sub))).toBe(rp(root));
    expect(resolveProjectRoot(rp(root))).toBe(rp(root));
  });

  it('stops at a .pi marker when no .git ancestor exists', () => {
    const root = tempDir('pi-messenger-rpr-pi-');
    fs.mkdirSync(path.join(root, '.pi'), { recursive: true });
    const sub = path.join(root, 'nested', 'dir');
    fs.mkdirSync(sub, { recursive: true });

    expect(resolveProjectRoot(rp(sub))).toBe(rp(root));
  });

  it('falls back to the start dir when no .git/.pi ancestor exists', () => {
    const orphan = tempDir('pi-messenger-rpr-orphan-');
    const sub = path.join(orphan, 'a', 'b');
    fs.mkdirSync(sub, { recursive: true });

    expect(resolveProjectRoot(rp(sub))).toBe(rp(sub));
  });

  it('falls back to the worktree itself when commondir metadata is missing', () => {
    // Simulate a corrupt/manual .git file without a readable commondir.
    const fake = tempDir('pi-messenger-rpr-fake-');
    fs.writeFileSync(path.join(fake, '.git'), 'gitdir: /nonexistent/common/.git/worktrees/x');

    expect(resolveProjectRoot(rp(fake))).toBe(rp(fake));
  });
});
