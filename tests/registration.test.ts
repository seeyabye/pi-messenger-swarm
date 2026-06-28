/**
 * Regression tests for the duplicate-registration naming bug (task-6).
 *
 * Bug: with PI_AGENT_NAME unset (human-terminal fallback), one agent (one
 * pid + sessionId) got TWO registry entries with divergent random names —
 * a 'harness' stub (model:'harness', isHuman:false) created at join time,
 * and the real agent (real model, isHuman:true) created later with a
 * DIFFERENT name. `join` returned the stub name; `status`/`list` resolved
 * to the other.
 *
 * Root cause: store/registration.ts register() keyed lookup/overwrite by
 * state.agentName (the NAME), never by (pid, sessionId), so two register()
 * calls for the same agent each ran generateMemorableName() independently.
 *
 * Fix: register() now reconciles with an existing same-(pid, sessionId)
 * registration and reuses its name before generating a new one, so the real
 * registration UPDATEs the stub (one stable name that join and status agree
 * on). The spawned-agent path (PI_AGENT_NAME set → explicit name) is unaffected.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { AgentRegistration, Dirs, MessengerState } from '../lib.js';
import * as store from '../store.js';
import { invalidateAgentsCache } from '../store.js';

const roots = new Set<string>();

function createDirs(cwd: string): Dirs {
  const base = path.join(cwd, '.pi', 'messenger');
  const registry = path.join(base, 'registry');
  fs.mkdirSync(registry, { recursive: true });
  return { base, registry };
}

function createState(
  callerPid: number | undefined,
  sessionId: string,
  overrides: Partial<MessengerState> = {}
): MessengerState {
  return {
    agentName: '',
    registered: false,
    reservations: [],
    chatHistory: new Map(),
    unreadCounts: new Map(),
    channelPostHistory: [],
    seenSenders: new Map(),
    model: '',
    gitBranch: undefined,
    spec: undefined,
    scopeToFolder: false,
    isHuman: false,
    session: { toolCalls: 0, tokens: 0, filesModified: [] },
    activity: { lastActivityAt: new Date().toISOString() },
    statusMessage: undefined,
    customStatus: false,
    registryFlushTimer: null,
    sessionStartedAt: new Date().toISOString(),
    contextSessionId: sessionId,
    callerPid,
    currentChannel: '',
    sessionChannel: '',
    joinedChannels: [],
    ...overrides,
  } as MessengerState;
}

function createCtx(
  cwd: string,
  sessionId: string,
  model: string,
  hasUI: boolean
): ExtensionContext {
  return {
    hasUI,
    cwd,
    ui: {
      theme: { fg: (_c: string, t: string) => t },
      notify: () => {},
      setStatus: () => {},
    },
    sessionManager: { getEntries: () => [], getSessionId: () => sessionId },
    model,
  } as unknown as ExtensionContext;
}

function readReg(dirs: Dirs, name: string): AgentRegistration {
  return JSON.parse(fs.readFileSync(path.join(dirs.registry, `${name}.json`), 'utf-8'));
}

function registryFiles(dirs: Dirs): string[] {
  return fs.readdirSync(dirs.registry).filter((f) => f.endsWith('.json'));
}

afterEach(() => {
  invalidateAgentsCache();
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  roots.clear();
});

describe('register() — duplicate-registration naming (task-6)', () => {
  it('reconciles harness stub + real agent into ONE file with a stable name', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-reg-test-'));
    roots.add(cwd);
    const dirs = createDirs(cwd);
    const sessionId = 'pi-session-XYZ';
    const pid = process.pid;

    // 1) harness 'join' stub: model='harness', hasUI=false, callerPid=<pi pid>
    //    (mirrors harness/server.ts resolveAgentState setting state.callerPid
    //    from the x-caller-pid header forwarded by the CLI).
    const harnessState = createState(pid, sessionId);
    const harnessCtx = createCtx(cwd, sessionId, 'harness', false);
    expect(store.register(harnessState, dirs, harnessCtx)).toBe(true);
    const stubName = harnessState.agentName;
    expect(stubName).toBeTruthy();
    expect(registryFiles(dirs)).toEqual([`${stubName}.json`]);

    // 2) in-process real agent: model=<real>, hasUI=true, callerPid UNSET
    //    (extension index.ts calls store.register directly; effectivePid
    //    falls back to process.pid, which equals the stub's pid).
    const realState = createState(undefined, sessionId, { isHuman: true });
    const realCtx = createCtx(cwd, sessionId, 'umans-glm-5.2', true);
    expect(store.register(realState, dirs, realCtx)).toBe(true);
    const realName = realState.agentName;

    // ONE registration per (pid, sessionId); the real registration reuses the
    // stub's name so `join` and `status`/`list` agree.
    expect(registryFiles(dirs)).toEqual([`${stubName}.json`]);
    expect(realName).toBe(stubName);

    // The real registration UPDATEs the stub: real model + isHuman win.
    const reg = readReg(dirs, stubName);
    expect(reg.model).toBe('umans-glm-5.2');
    expect(reg.isHuman).toBe(true);
    expect(reg.pid).toBe(pid);
    expect(reg.sessionId).toBe(sessionId);
  });

  it('does not create a duplicate when the real agent registers twice (idempotent)', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-reg-test-'));
    roots.add(cwd);
    const dirs = createDirs(cwd);
    const sessionId = 'pi-session-ABC';
    const pid = process.pid;

    const ctx = createCtx(cwd, sessionId, 'umans-glm-5.2', true);
    const s1 = createState(undefined, sessionId, { isHuman: true });
    expect(store.register(s1, dirs, ctx)).toBe(true);
    const firstName = s1.agentName;

    // A second in-process registration for the same (pid, sessionId) — e.g.
    // a re-registration after /messenger re-open — must reuse the same name.
    const s2 = createState(undefined, sessionId, { isHuman: true });
    expect(store.register(s2, dirs, ctx)).toBe(true);

    expect(s2.agentName).toBe(firstName);
    expect(registryFiles(dirs)).toEqual([`${firstName}.json`]);
  });

  it('reconciles by pid even when the stub has an empty sessionId (session-id file absent)', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-reg-test-'));
    roots.add(cwd);
    const dirs = createDirs(cwd);
    const pid = process.pid;

    // Stub created before the session-id file existed: sessionId=''.
    const stubCtx = createCtx(cwd, '', 'harness', false);
    const stubState = createState(pid, '');
    expect(store.register(stubState, dirs, stubCtx)).toBe(true);
    const stubName = stubState.agentName;
    expect(readReg(dirs, stubName).sessionId).toBe('');

    // Real agent now has a real sessionId (session-id file now present).
    const realCtx = createCtx(cwd, 'pi-session-LATE', 'umans-glm-5.2', true);
    const realState = createState(undefined, 'pi-session-LATE', { isHuman: true });
    expect(store.register(realState, dirs, realCtx)).toBe(true);

    // Still reconciled by pid -> ONE file, name stable.
    expect(registryFiles(dirs)).toEqual([`${stubName}.json`]);
    expect(realState.agentName).toBe(stubName);
  });

  it('does NOT regress the spawned-agent path (explicit name is honored, not reconciled away)', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-reg-test-'));
    roots.add(cwd);
    const dirs = createDirs(cwd);
    const sessionId = 'pi-session-SPAWN';
    const pid = process.pid;

    // A pre-existing harness stub for the same process (as can happen when the
    // parent's harness join ran first).
    const stubState = createState(pid, sessionId);
    const stubCtx = createCtx(cwd, sessionId, 'harness', false);
    expect(store.register(stubState, dirs, stubCtx)).toBe(true);
    const stubName = stubState.agentName;

    // Spawned agent: PI_AGENT_NAME set -> state.agentName is the explicit name.
    // register() must use THAT name, not silently reuse the stub's name.
    const explicitName = 'SpawnedFox';
    const spawnedState = createState(undefined, sessionId, { agentName: explicitName });
    const spawnedCtx = createCtx(cwd, sessionId, 'umans-glm-5.2', false);
    expect(store.register(spawnedState, dirs, spawnedCtx)).toBe(true);

    expect(spawnedState.agentName).toBe(explicitName);
    // The spawned agent keeps its own explicit-name file (the stub is not
    // reconciled away because the spawned path sets state.agentName explicitly).
    expect(fs.existsSync(path.join(dirs.registry, `${explicitName}.json`))).toBe(true);
    // stub file untouched by the spawned registration
    expect(readReg(dirs, stubName).model).toBe('harness');
  });
});
