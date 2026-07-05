import * as fs from 'node:fs';
import * as path from 'node:path';
function ensureDir(dir) {
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
}
export function getTasksJsonlPath(cwd, sessionId) {
    const safeSessionId = sessionId.replace(/[^\w.-]/g, '_');
    return path.join(cwd, '.pi', 'messenger', 'tasks', `${safeSessionId}.jsonl`);
}
export function getTaskSpecsDir(cwd, sessionId) {
    const safeSessionId = sessionId.replace(/[^\w.-]/g, '_');
    return path.join(cwd, '.pi', 'messenger', 'tasks', safeSessionId);
}
export function taskSpecPath(cwd, sessionId, taskId) {
    return path.join(getTaskSpecsDir(cwd, sessionId), `${taskId}.md`);
}
export function writeTaskSpec(cwd, sessionId, taskId, title, content) {
    const specPath = taskSpecPath(cwd, sessionId, taskId);
    ensureDir(path.dirname(specPath));
    fs.writeFileSync(specPath, content?.trim() ? `# ${title}\n\n${content.trim()}\n` : `# ${title}\n\n*Spec pending*\n`, 'utf-8');
}
export function readTaskSpec(cwd, sessionId, taskId) {
    const specPath = taskSpecPath(cwd, sessionId, taskId);
    if (!fs.existsSync(specPath))
        return null;
    try {
        return fs.readFileSync(specPath, 'utf-8');
    }
    catch {
        return null;
    }
}
export function deleteTaskSpec(cwd, sessionId, taskId) {
    try {
        fs.unlinkSync(taskSpecPath(cwd, sessionId, taskId));
    }
    catch {
        // Ignore errors
    }
}
export { ensureDir };
