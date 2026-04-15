/**
 * Sanitized logger utility — logs to stderr (MCP servers must not write to stdout).
 */
export function info(message, data) {
    if (data !== undefined) {
        console.error(`[INFO] ${message}`, JSON.stringify(data));
    }
    else {
        console.error(`[INFO] ${message}`);
    }
}
export function warn(message, data) {
    if (data !== undefined) {
        console.error(`[WARN] ${message}`, JSON.stringify(data));
    }
    else {
        console.error(`[WARN] ${message}`);
    }
}
export function error(message, err) {
    if (err instanceof Error) {
        console.error(`[ERROR] ${message}:`, err.message);
    }
    else if (err !== undefined) {
        console.error(`[ERROR] ${message}:`, JSON.stringify(err));
    }
    else {
        console.error(`[ERROR] ${message}`);
    }
}
export function debug(message, data) {
    if (!process.env.DEBUG)
        return;
    if (data !== undefined) {
        console.error(`[DEBUG] ${message}`, JSON.stringify(data));
    }
    else {
        console.error(`[DEBUG] ${message}`);
    }
}
//# sourceMappingURL=logger.js.map