import { basename, isAbsolute, resolve, relative } from 'node:path';
export function extractFolder(cwd) {
    return basename(cwd) || cwd;
}
export function resolveSpecPath(specPath, cwd) {
    if (isAbsolute(specPath))
        return specPath;
    return resolve(cwd, specPath);
}
export function displaySpecPath(absPath, cwd) {
    try {
        const rel = relative(cwd, absPath);
        if (rel === '')
            return '.';
        if (!rel.startsWith('..') && !isAbsolute(rel)) {
            return './' + rel;
        }
    }
    catch {
        // Ignore and fall back to absolute
    }
    return absPath;
}
export function truncatePathLeft(filePath, maxLen) {
    if (filePath.length <= maxLen)
        return filePath;
    if (maxLen <= 1)
        return '…';
    const truncated = filePath.slice(-(maxLen - 1));
    const slashIdx = truncated.indexOf('/');
    if (slashIdx > 0) {
        return '…' + truncated.slice(slashIdx);
    }
    return '…' + truncated;
}
export function pathMatchesReservation(filePath, pattern) {
    if (pattern.endsWith('/')) {
        return filePath.startsWith(pattern) || filePath + '/' === pattern;
    }
    return filePath === pattern;
}
