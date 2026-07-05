export { computeStatus, formatDuration, STATUS_INDICATORS, generateAutoStatus, buildSelfRegistration, agentHasTask, } from './lib/status.js';
export { generateMemorableName, isValidAgentName, agentColorCode, coloredAgentName, } from './lib/names.js';
export { extractFolder, resolveSpecPath, displaySpecPath, truncatePathLeft, pathMatchesReservation, } from './lib/paths.js';
export { isProcessAlive, formatRelativeTime, stripAnsiCodes } from './lib/format.js';
// Constants
export const MAX_CHAT_HISTORY = 50;
