/**
 * Regression tests for getEffectiveSessionId's disk fallback.
 *
 * The in-process spawn/message poll calls getEffectiveSessionId when
 * state.contextSessionId is empty (e.g. autoRegister off). It used to read
 * only the singleton `<messenger>/session-id`, which two concurrent sessions
 * in the same project clobber. It now prefers `<messenger>/sessions/<pid>`
 * (process.pid, since this runs in-process) before the singleton.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getEffectiveSessionId } from '../../store/shared.js';
import type { MessengerState } from '../../lib.js';

const roots = new Set<string>();

function tempMessengerDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-messenger-effective-sid-'));
  roots.add(root);
  return root;
}

/**
 * getEffectiveSessionId resolves its base from cwd (via getMessengerBase),
 * so a tempdir with no .git/.pi ancestor resolves to <dir>/.pi/messenger.
 * Build the session-id files there.
 */
function messengerBase(dir: string): string {
  return path.join(dir, '.pi', 'messenger');
}

function emptyState(): MessengerState {
  return {
    agentName: '',
    registered: false,
    currentChannel: '',
    sessionChannel: '',
    contextSessionId: undefined,
  } as MessengerState;
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

describe('getEffectiveSessionId — per-pid disk fallback', () => {
  it('prefers sessions/<pid> over the singleton', () => {
    const dir = tempMessengerDir();
    const base = messengerBase(dir);
    const sessionsDir = path.join(base, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, String(process.pid)), 'my-session', 'utf-8');
    fs.writeFileSync(path.join(base, 'session-id'), 'other-session', 'utf-8');

    expect(getEffectiveSessionId(dir, emptyState())).toBe('my-session');
  });

  it('falls back to the singleton when no per-pid entry exists', () => {
    const dir = tempMessengerDir();
    const base = messengerBase(dir);
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, 'session-id'), 'singleton-session', 'utf-8');

    expect(getEffectiveSessionId(dir, emptyState())).toBe('singleton-session');
  });

  it('returns empty string when nothing is on disk', () => {
    const dir = tempMessengerDir();
    expect(getEffectiveSessionId(dir, emptyState())).toBe('');
  });

  it('state.contextSessionId wins over the disk fallback', () => {
    const dir = tempMessengerDir();
    const base = messengerBase(dir);
    const sessionsDir = path.join(base, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, String(process.pid)), 'disk-session', 'utf-8');

    const state = emptyState();
    state.contextSessionId = 'in-memory-session';
    expect(getEffectiveSessionId(dir, state)).toBe('in-memory-session');
  });
});
