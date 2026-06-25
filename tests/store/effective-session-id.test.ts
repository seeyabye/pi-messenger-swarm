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
const prevDir = process.env.PI_MESSENGER_DIR;

function tempMessengerDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-messenger-effective-sid-'));
  roots.add(root);
  return root;
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
  if (prevDir === undefined) delete process.env.PI_MESSENGER_DIR;
  else process.env.PI_MESSENGER_DIR = prevDir;
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
    process.env.PI_MESSENGER_DIR = dir;
    const sessionsDir = path.join(dir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, String(process.pid)), 'my-session', 'utf-8');
    fs.writeFileSync(path.join(dir, 'session-id'), 'other-session', 'utf-8');

    expect(getEffectiveSessionId('/unused/cwd', emptyState())).toBe('my-session');
  });

  it('falls back to the singleton when no per-pid entry exists', () => {
    const dir = tempMessengerDir();
    process.env.PI_MESSENGER_DIR = dir;
    fs.writeFileSync(path.join(dir, 'session-id'), 'singleton-session', 'utf-8');

    expect(getEffectiveSessionId('/unused/cwd', emptyState())).toBe('singleton-session');
  });

  it('returns empty string when nothing is on disk', () => {
    const dir = tempMessengerDir();
    process.env.PI_MESSENGER_DIR = dir;
    expect(getEffectiveSessionId('/unused/cwd', emptyState())).toBe('');
  });

  it('state.contextSessionId wins over the disk fallback', () => {
    const dir = tempMessengerDir();
    process.env.PI_MESSENGER_DIR = dir;
    const sessionsDir = path.join(dir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, String(process.pid)), 'disk-session', 'utf-8');

    const state = emptyState();
    state.contextSessionId = 'in-memory-session';
    expect(getEffectiveSessionId('/unused/cwd', state)).toBe('in-memory-session');
  });
});
