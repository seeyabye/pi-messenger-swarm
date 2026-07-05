export function result(text, details) {
    return {
        content: [{ type: "text", text }],
        details,
    };
}
