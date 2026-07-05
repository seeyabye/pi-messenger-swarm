/**
 * Pure session-id resolution for the CLI. Extracted from harness/cli.ts so it
 * can be unit-tested without importing the CLI (which runs `main()` on import).
 *
 * Why per-pid:
 * The extension historically wrote a single `<messenger>/session-id` file on
 * session_start, and the CLI read it to build the `x-session-id` header. With
 * two pi sessions in the SAME project, the second session overwrites the file,
 * so both sessions' CLI calls end up carrying the last-written session id.
 * That leaks tasks/spawns/notifications between the two sessions (the CLI then
 * resolves the wrong per-session storage and the harness's session-mismatch
 * logic corrupts channel metadata).
 *
 * Fix: the extension also writes `<messenger>/sessions/<pid>` (the pi process
 * pid). The CLI resolves its caller pid (findCallerPid, which walks up to the
 * owning `pi` process) and reads that entry — so each session gets its own id.
 * The singleton `session-id` file is kept as a fallback for backward
 * compatibility and for callers whose pid can't be resolved (human terminals).
 *
 * Resolution priority:
 *   1. <messenger>/sessions/<callerPid>   (per-pid, concurrent-session safe)
 *   2. <messenger>/session-id             (singleton fallback)
 */
import * as fs from 'node:fs';
import { join } from 'node:path';
function readTrim(filePath) {
    try {
        if (!fs.existsSync(filePath))
            return undefined;
        const id = fs.readFileSync(filePath, 'utf-8').trim();
        return id || undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * Resolve the session id the CLI should send as `x-session-id`.
 * Returns undefined when no session-id is known (e.g. before the extension
 * has written one, or running outside a project).
 */
export function resolveSessionId(options) {
    const { projectRoot, callerPid } = options;
    const messengerDir = join(projectRoot, '.pi', 'messenger');
    // 1. Per-pid entry — each concurrent pi session resolves its own id.
    if (callerPid) {
        const perPid = readTrim(join(messengerDir, 'sessions', String(callerPid)));
        if (perPid)
            return perPid;
    }
    // 2. Singleton fallback.
    return readTrim(join(messengerDir, 'session-id'));
}
