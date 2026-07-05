/**
 * Swarm live progress tracking helpers.
 */
export function parseJsonlLine(line) {
    if (!line.trim())
        return null;
    try {
        return JSON.parse(line);
    }
    catch {
        return null;
    }
}
export function createProgress(agent) {
    return {
        agent,
        status: 'pending',
        recentTools: [],
        toolCallCount: 0,
        tokens: 0,
        durationMs: 0,
    };
}
export function updateProgress(progress, event, startTime) {
    progress.durationMs = Date.now() - startTime;
    switch (event.type) {
        case 'tool_execution_start':
            progress.status = 'running';
            progress.currentTool = event.toolName;
            progress.currentToolArgs = extractArgsPreview(event.args);
            progress.currentToolStartMs = Date.now();
            break;
        case 'tool_execution_end':
            progress.toolCallCount++;
            if (progress.currentTool) {
                progress.recentTools.push({
                    tool: progress.currentTool,
                    args: progress.currentToolArgs ?? '',
                    startMs: progress.currentToolStartMs ?? Date.now(),
                    endMs: Date.now(),
                });
            }
            progress.currentTool = undefined;
            progress.currentToolArgs = undefined;
            progress.currentToolStartMs = undefined;
            break;
        case 'message_end':
            if (event.message?.usage) {
                progress.tokens += (event.message.usage.input ?? 0) + (event.message.usage.output ?? 0);
            }
            if (event.message?.errorMessage) {
                progress.error = event.message.errorMessage;
            }
            break;
    }
}
function extractArgsPreview(args) {
    if (!args)
        return '';
    const previewKeys = ['command', 'path', 'file_path', 'pattern', 'query'];
    for (const key of previewKeys) {
        if (args[key] && typeof args[key] === 'string') {
            const value = args[key].replaceAll('\n', ' ').replaceAll('\r', '');
            return value.length > 60 ? `${value.slice(0, 57)}...` : value;
        }
    }
    return '';
}
