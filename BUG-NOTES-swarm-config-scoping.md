# pi-messenger — Bug Notes: config cache invalidation (RESOLVED) + scoping investigation

> Status: untracked notes (not committed). Captured 2026-06-25 while orchestrating a swarm.
> Version observed: **0.25.21**
> **Update 2026-06-25 10:15:** After reading the source + existing tests, only **Bug 1** was a real bug — and it's now **fixed** (see Fix below). Bugs 2/3/4 were **misdiagnoses** caused by the chaotic live session; the code + tests (`tests/swarm/per-request-project`, `project-isolation`, `soft-restart`) show the intended behavior is correct. See "Corrected verdict" under each.
> Reporter context: invoking `pi-messenger-swarm` from `/Users/choong/gsd-workspaces/architecture-refactor` (workspace root) and `…/javinizer-go` (subdir), against a server whose process cwd is the hardcoded `/Users/choong/Projects/pi-messenger`.

## Key facts (verified)

The shell wrapper `~/.pi/agent/bin/pi-messenger-swarm` is:

```sh
#!/bin/sh
export PI_MESSENGER_CALLER_CWD="$(pwd)"
cd "/Users/choong/Projects/pi-messenger" 2>/dev/null
exec node "/Users/choong/Projects/pi-messenger/dist/harness/cli.js" "$@"
```

So the server **process cwd is always** `/Users/choong/Projects/pi-messenger` (hardcoded), and the user's real cwd is carried **only** in `PI_MESSENGER_CALLER_CWD` (re-exported per invocation).

Verified server env (pid 46764):

- `process.cwd()` → `/Users/choong/Projects/pi-messenger`
- `PI_MESSENGER_CALLER_CWD` → `/Users/choong/gsd-workspaces/architecture-refactor` (the dir `--start` was invoked from)
- `PI_MESSENGER_DIR` → `…/architecture-refactor/.pi/messenger`

---

## Bug 1 — `configCache` cached `loadConfig(cwd)` indefinitely → edits to `.pi/pi-messenger.json` had no effect until full restart ✅ FIXED

**Symptom:** Editing `.pi/pi-messenger.json` (e.g. raising `maxConcurrentSpawns` 3→8) after the server was running had no effect; spawns kept failing with `Error: N subagents already running (limit: 3)`. Only a full `--stop`+`--start` applied the change.

**Real root cause (confirmed in source):** `harness/server.ts` had a per-cwd `configCache: Map<cwd, MessengerConfig>` populated by `configForCwd()` and **never invalidated** except by the `/restart` endpoint. `loadConfig` itself reads fresh, but `configForCwd` returned the cached object on every subsequent request for that cwd. So the limit (resolved per-request via `routerConfigForCwd(projectCwd)` ← `configForCwd`) was frozen at whatever the first request from that project-cwd saw.

**Fix applied:**

- `config.ts`: added `loadConfigCached(cwd, forceRefresh?)` — caches per cwd but re-reads when the project `.pi/pi-messenger.json` **mtime** changes (covers edit/create/delete). Added `clearConfigCache()`.
- `harness/server.ts`: `configForCwd` now delegates to `loadConfigCached`; `/restart` calls `clearConfigCache` (was `configCache.clear()`).
- `tests/config-cache.test.ts`: 6 new tests pinning edit/create/delete/forceRefresh/clear behavior (257 total pass).
- `dist/` rebuilt. Fix takes effect on next server restart (the live server pid 46764 was deliberately NOT restarted — swarm workers depend on it).

**Note:** the original notes mis-blamed "read once at server start from start-cwd". Actually it was read once **per cwd** on first request, then cached forever. The observable symptom was identical.

---

## Bug 2 — Project scoping is caller-cwd based; `PI_MESSENGER_DIR` does NOT redirect scope ⚠️ MISDIAGNOSIS (intentional behavior)

**Corrected verdict:** This is **by design**, not a bug. `scopeToFolder: true` (project-scoped isolation) is the documented default. The code DOES honor `PI_MESSENGER_DIR` as a per-request override: `harness/cli.ts:295` forwards it as the `x-messenger-dir` header, and `harness/server.ts:571` passes it as `overrideBase` to `resolveMessengerDirs` (highest priority, per `harness/paths.ts`). My live-session test "failed" because of confounding factors (cached registrations, the `--task-id` string passing through despite scope, and my own cwd hopping), not because the override is broken. `tests/swarm/project-isolation.test.ts` + `tests/harness/paths.test.ts` cover this.

**What IS worth doing (not done — minor docs gap):** The SKILL.md `PI_MESSENGER_DIR` blurb ("Custom directory") could clarify that it overrides the **data/scope dir per-request** when set on the client env. No code change needed.

---

## Bug 3 — `--restart` neither re-reads config nor changes server cwd ⚠️ MISDIAGNOSIS

**Corrected verdict:** `--restart` **does** clear both `configCache` and `dirsCache` — `harness/cli.ts:558` POSTs to `/restart`, and `harness/server.ts:692` clears both caches. I misread the output: `--restart` prints the `/health` body afterward (which shows high `uptime` because soft-restart **preserves** the process and agents — that's the point), so it _looked_ like nothing happened. With the Bug 1 fix, `--restart` is no longer even needed for config edits (mtime invalidation handles it); `--restart` remains a valid full-cache-clear. No change needed.

---

## Bug 4 — Wrapper hardcodes `cd` into the pi-messenger repo ⚠️ NOT A BUG (cosmetic)

**Corrected verdict:** The wrapper's `cd` only affects the **CLI client** process cwd, not resolution — the CLI immediately re-derives the real cwd from `PI_MESSENGER_CALLER_CWD` (set by the wrapper _before_ the `cd`) and sends it via `x-caller-cwd`. The server's `process.cwd()` is only a last-resort fallback when no header is present. The `cd` exists so the CLI can reliably locate `dist/harness/cli.js` via a known path. It's brittle-looking but functionally correct. No change needed (a future cleanup could resolve cli.js by absolute path without `cd`, but that's style, not a bug).

---

## Reproduction (Bug 1, now fixed)

```sh
cd /tmp/A && mkdir -p .pi && echo '{"maxConcurrentSpawns": 2}' > .pi/pi-messenger.json
pi-messenger-swarm --start
pi-messenger-swarm spawn --role R "do 1" &
pi-messenger-swarm spawn --role R "do 2" &
pi-messenger-swarm spawn --role R "do 3"    # ❌ "limit: 2" (expected)

echo '{"maxConcurrentSpawns": 8}' > .pi/pi-messenger.json
# BEFORE fix: still "limit: 2" until --stop/--start.
# AFTER fix: next spawn honors 8 (mtime invalidation re-reads).
pi-messenger-swarm spawn --role R "do 3"    # ✅ ok
```

## Files changed by the fix

- `config.ts` — added `loadConfigCached` + `clearConfigCache` (mtime-aware cache)
- `harness/server.ts` — `configForCwd` delegates to `loadConfigCached`; `/restart` calls `clearConfigCache`
- `tests/config-cache.test.ts` — 6 new regression tests

## Lesson learned (process note)

Diagnosing from a chaotic multi-agent live session is unreliable: the same symptoms ("limit 3", "scope split", "restart did nothing") had multiple plausible causes and I conflated them. Reading the source + existing tests revealed 3 of 4 "bugs" were intended behavior already covered by tests. Always confirm against code before fixing.
