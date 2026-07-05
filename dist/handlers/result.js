export function result(text, details) {
    return {
        content: [{ type: 'text', text }],
        details,
    };
}
export function notRegisteredError() {
    return result('Not registered. Use \`pi-messenger-swarm join\` to join the agent mesh first.', {
        mode: 'error',
        error: 'not_registered',
    });
}
