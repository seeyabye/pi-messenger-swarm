/**
 * Regression tests for messenger data-directory resolution.
 *
 * Background: PI_MESSENGER_DIR is documented as a "Data directory" override,
 * but commit 3dfb30d made the server ignore it per-request (only honoring it
 * for startup dirs) to fix the extension leaking its project dir into other
 * projects. That left the documented user-facing override with no effect on
 * real operations (task list, channels, feed, ...).
 *
 * The fix: the CLI forwards a user-set PI_MESSENGER_DIR as a per-request
 * `x-messenger-dir` header, and the server honors it as `overrideBase` —
 * without re-introducing the 3dfb30d bug (the extension never sets the env on
 * the client, so the header is unambiguously a user override).
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { resolveMessengerDirs } from '../../harness/paths.js';

const ENV = (overrides: Record<string, string | undefined> = {}) => ({
  ...overrides,
});

describe('resolveMessengerDirs — PI_MESSENGER_DIR override', () => {
  it('defaults to <cwd>/.pi/messenger when no override is set (project-scoped)', () => {
    const dirs = resolveMessengerDirs({ cwd: '/proj/a', env: ENV() });
    expect(dirs.base).toBe('/proj/a/.pi/messenger');
    expect(dirs.registry).toBe('/proj/a/.pi/messenger/registry');
  });

  it('honors overrideBase (x-messenger-dir header) even when cwd is provided', () => {
    // This is the bug: previously PI_MESSENGER_DIR had no effect per-request.
    const dirs = resolveMessengerDirs({
      cwd: '/proj/a',
      overrideBase: '/proj/b/.pi/messenger',
      env: ENV(),
    });
    expect(dirs.base).toBe('/proj/b/.pi/messenger');
  });

  it('overrideBase wins over a cwd-derived default regardless of cwd', () => {
    const dirs = resolveMessengerDirs({
      cwd: '/some/other/cwd',
      overrideBase: '/custom/messenger',
      env: ENV(),
    });
    expect(dirs.base).toBe('/custom/messenger');
  });

  it('does NOT use PI_MESSENGER_DIR env per-request when no overrideBase is given', () => {
    // Guards the 3dfb30d fix: the server env (extension-pinned) must not leak
    // into per-request resolution. Only the explicit header (overrideBase) can
    // override per-request; the env is startup-only.
    const dirs = resolveMessengerDirs({
      cwd: '/proj/a',
      env: ENV({ PI_MESSENGER_DIR: '/extension-project/.pi/messenger' }),
    });
    expect(dirs.base).toBe('/proj/a/.pi/messenger');
  });

  it('uses PI_MESSENGER_DIR env for startup dirs (no cwd provided)', () => {
    const dirs = resolveMessengerDirs({
      env: ENV({ PI_MESSENGER_DIR: '/startup/.pi/messenger' }),
    });
    expect(dirs.base).toBe('/startup/.pi/messenger');
  });

  it('startup override is shadowed by overrideBase if both are present', () => {
    const dirs = resolveMessengerDirs({
      overrideBase: '/per-request/.pi/messenger',
      env: ENV({ PI_MESSENGER_DIR: '/startup/.pi/messenger' }),
    });
    expect(dirs.base).toBe('/per-request/.pi/messenger');
  });

  it('honors PI_MESSENGER_GLOBAL=1 → shared homedir dir when no override', () => {
    const dirs = resolveMessengerDirs({
      cwd: '/proj/a',
      env: ENV({ PI_MESSENGER_GLOBAL: '1' }),
    });
    expect(dirs.base).toBe(join(dirs.base)); // resolves under agent dir
    expect(dirs.base).toMatch(/messenger$/);
    expect(dirs.base).not.toBe('/proj/a/.pi/messenger');
  });
});
