/**
 * Regression test for the config-cache invalidation bug.
 *
 * Symptom: harness/server.ts cached loadConfig(cwd) per cwd indefinitely, so
 * editing `.pi/pi-messenger.json` (e.g. raising maxConcurrentSpawns) had no
 * effect until a full --restart. The fix: loadConfigCached() re-reads when the
 * project config file's mtime changes. This test pins that behavior.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempMessengerDirs, type TempMessengerDirs } from './helpers/temp-dirs.js';

const homedirMock = vi.hoisted(() => vi.fn());

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: homedirMock,
  };
});

async function loadConfigModule() {
  vi.resetModules();
  return import('../config.js');
}

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// Some filesystems have coarse mtime resolution (1s on HFS+, coarse on some
// network/CI mounts). To make this test deterministic across filesystems we
// bump mtime explicitly rather than relying on sub-second write timing.
function bumpMtime(filePath: string, aheadSeconds: number): void {
  const future = new Date(Date.now() + aheadSeconds * 1000);
  fs.utimesSync(filePath, future, future);
}

describe('loadConfigCached — mtime invalidation', () => {
  let dirs: TempMessengerDirs;

  beforeEach(() => {
    dirs = createTempMessengerDirs();
    homedirMock.mockReset();
    homedirMock.mockReturnValue(path.join(dirs.root, '.pi-home'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the same config across calls when the file is unchanged', async () => {
    const projectConfig = path.join(dirs.cwd, '.pi', 'pi-messenger.json');
    writeJson(projectConfig, { maxConcurrentSpawns: 5 });

    const { loadConfigCached } = await loadConfigModule();
    const first = loadConfigCached(dirs.cwd);
    const second = loadConfigCached(dirs.cwd);

    expect(first.maxConcurrentSpawns).toBe(5);
    expect(second).toBe(first); // cached — same object reference
  });

  it('re-reads the config after the project file is edited (no restart)', async () => {
    const projectConfig = path.join(dirs.cwd, '.pi', 'pi-messenger.json');
    writeJson(projectConfig, { maxConcurrentSpawns: 3 });

    const { loadConfigCached } = await loadConfigModule();
    expect(loadConfigCached(dirs.cwd).maxConcurrentSpawns).toBe(3);

    // Edit the file (raise the limit) and bump mtime so the change is detected
    // even on coarse-mtime filesystems.
    writeJson(projectConfig, { maxConcurrentSpawns: 8 });
    bumpMtime(projectConfig, 5);

    // WITHOUT a restart, the next read reflects the new limit.
    expect(loadConfigCached(dirs.cwd).maxConcurrentSpawns).toBe(8);
  });

  it('re-reads when the project file is created after a cached read', async () => {
    // First read: no project config → defaults
    const { loadConfigCached } = await loadConfigModule();
    expect(loadConfigCached(dirs.cwd).maxConcurrentSpawns).toBe(3); // default

    // Now create the project config
    const projectConfig = path.join(dirs.cwd, '.pi', 'pi-messenger.json');
    writeJson(projectConfig, { maxConcurrentSpawns: 12 });
    bumpMtime(projectConfig, 5);

    expect(loadConfigCached(dirs.cwd).maxConcurrentSpawns).toBe(12);
  });

  it('re-reads when the project file is deleted after a cached read', async () => {
    const projectConfig = path.join(dirs.cwd, '.pi', 'pi-messenger.json');
    writeJson(projectConfig, { maxConcurrentSpawns: 7 });

    const { loadConfigCached } = await loadConfigModule();
    expect(loadConfigCached(dirs.cwd).maxConcurrentSpawns).toBe(7);

    // Delete the project config → falls back to defaults
    fs.unlinkSync(projectConfig);

    expect(loadConfigCached(dirs.cwd).maxConcurrentSpawns).toBe(3); // default
  });

  it('forceRefresh bypasses the cache even when mtime is unchanged', async () => {
    const projectConfig = path.join(dirs.cwd, '.pi', 'pi-messenger.json');
    writeJson(projectConfig, { maxConcurrentSpawns: 4 });

    const { loadConfigCached } = await loadConfigModule();
    const first = loadConfigCached(dirs.cwd);

    // Mutate the file content but restore the SAME mtime so the mtime check
    // alone would NOT detect the change. forceRefresh must still re-read.
    const originalMtime = fs.statSync(projectConfig).mtimeMs;
    writeJson(projectConfig, { maxConcurrentSpawns: 9 });
    fs.utimesSync(projectConfig, new Date(originalMtime / 1000), new Date(originalMtime / 1000));

    const forced = loadConfigCached(dirs.cwd, true);
    expect(forced.maxConcurrentSpawns).toBe(9);
    expect(forced).not.toBe(first); // fresh object, not the cached one
  });

  it('clearConfigCache forces the next read to reload', async () => {
    const projectConfig = path.join(dirs.cwd, '.pi', 'pi-messenger.json');
    writeJson(projectConfig, { maxConcurrentSpawns: 6 });

    const { loadConfigCached, clearConfigCache } = await loadConfigModule();
    const first = loadConfigCached(dirs.cwd);
    expect(first.maxConcurrentSpawns).toBe(6);

    writeJson(projectConfig, { maxConcurrentSpawns: 2 });
    bumpMtime(projectConfig, 5);

    clearConfigCache();
    const after = loadConfigCached(dirs.cwd);
    expect(after.maxConcurrentSpawns).toBe(2);
    expect(after).not.toBe(first);
  });
});
