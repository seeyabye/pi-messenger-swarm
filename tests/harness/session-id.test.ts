/**
 * Regression tests for CLI session-id resolution (harness/session-id.ts).
 *
 * Background: the extension used to write a single `<messenger>/session-id`
 * file, and the CLI read it to build `x-session-id`. Two concurrent pi
 * sessions in the SAME project clobbered each other's file, so both sessions'
 * CLI calls carried the last writer's session id — leaking tasks/spawns/
 * notifications between sessions.
 *
 * The fix: the extension also writes `<messenger>/sessions/<pid>`, and the
 * CLI resolves its caller pid and reads that entry first (singleton is now a
 * fallback). These tests pin the resolution priority.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveSessionId } from '../../harness/session-id.js';

const roots = new Set<string>();

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-messenger-session-id-'));
  roots.add(root);
  return root;
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

describe('resolveSessionId — per-pid isolation', () => {
  it('prefers the per-pid entry matching the caller pid', () => {
    const root = tempRoot();
    const messengerDir = path.join(root, '.pi', 'messenger');
    const sessionsDir = path.join(messengerDir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, '100'), 'session-alpha', 'utf-8');
    fs.writeFileSync(path.join(sessionsDir, '200'), 'session-beta', 'utf-8');
    // Singleton exists too (last writer); per-pid must still win.
    fs.writeFileSync(path.join(messengerDir, 'session-id'), 'session-beta', 'utf-8');

    expect(resolveSessionId({ projectRoot: root, callerPid: 100 })).toBe('session-alpha');
    expect(resolveSessionId({ projectRoot: root, callerPid: 200 })).toBe('session-beta');
  });

  it('falls back to the singleton when no per-pid entry exists for the caller', () => {
    const root = tempRoot();
    const messengerDir = path.join(root, '.pi', 'messenger');
    const sessionsDir = path.join(messengerDir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, '100'), 'session-alpha', 'utf-8');
    fs.writeFileSync(path.join(messengerDir, 'session-id'), 'session-singleton', 'utf-8');

    // caller 999 has no per-pid entry → singleton
    expect(resolveSessionId({ projectRoot: root, callerPid: 999 })).toBe('session-singleton');
  });

  it('falls back to the singleton when caller pid is not resolvable', () => {
    const root = tempRoot();
    const messengerDir = path.join(root, '.pi', 'messenger');
    fs.mkdirSync(messengerDir, { recursive: true });
    fs.writeFileSync(path.join(messengerDir, 'session-id'), 'session-singleton', 'utf-8');

    expect(resolveSessionId({ projectRoot: root })).toBe('session-singleton');
  });

  it('returns undefined when no session-id is known at all', () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, '.pi', 'messenger'), { recursive: true });
    expect(resolveSessionId({ projectRoot: root, callerPid: 100 })).toBeUndefined();
    expect(resolveSessionId({ projectRoot: root })).toBeUndefined();
  });

  it('ignores an empty per-pid file and falls back', () => {
    const root = tempRoot();
    const messengerDir = path.join(root, '.pi', 'messenger');
    const sessionsDir = path.join(messengerDir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, '100'), '   \n', 'utf-8');
    fs.writeFileSync(path.join(messengerDir, 'session-id'), 'session-singleton', 'utf-8');

    expect(resolveSessionId({ projectRoot: root, callerPid: 100 })).toBe('session-singleton');
  });
});
