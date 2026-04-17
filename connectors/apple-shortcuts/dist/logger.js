/**
 * Sanitized logger utility
 *
 * NEVER log sensitive data like API keys, tokens, or Authorization headers.
 * This logger automatically redacts common credential patterns.
 */
const REDACT_PATTERNS = [
    /Authorization:\s*[^\s\n]+/gi,
    /"Authorization"\s*:\s*"[^"]+"/gi,
    /Bearer\s+[a-zA-Z0-9\-_.]+/gi,
    /api[_-]?key[=:]\s*[^\s&"'\n]+/gi,
    /"api[_-]?[kK]ey"\s*:\s*"[^"]+"/gi,
    /token[=:]\s*[^\s&"'\n]+/gi,
    /"token"\s*:\s*"[^"]+"/gi,
    /secret[=:]\s*[^\s&"'\n]+/gi,
    /"secret"\s*:\s*"[^"]+"/gi,
    /password[=:]\s*[^\s&"'\n]+/gi,
    /"password"\s*:\s*"[^"]+"/gi,
    /sk-[a-zA-Z0-9]{20,}/g,
    /ghp_[a-zA-Z0-9]{36}/g,
    /gho_[a-zA-Z0-9]{36}/g,
    /xoxb-[0-9]+-[a-zA-Z0-9]+/g,
    /xoxp-[0-9]+-[a-zA-Z0-9]+/g,
    /AKIA[0-9A-Z]{16}/g,
    /-----BEGIN[^-]+PRIVATE KEY-----[\s\S]*?-----END[^-]+PRIVATE KEY-----/g,
];
function redact(input) {
    let result = input;
    for (const pattern of REDACT_PATTERNS) {
        result = result.replace(pattern, '[REDACTED]');
    }
    return result;
}
function safeStringify(value) {
    if (value === undefined)
        return 'undefined';
    if (value === null)
        return 'null';
    if (typeof value === 'string')
        return redact(value);
    try {
        return redact(JSON.stringify(value, null, 2));
    }
    catch {
        return '[Unable to stringify]';
    }
}
export function info(message, data) {
    const sanitized = redact(message);
    if (data !== undefined) {
        console.error(`[INFO] ${sanitized}`, safeStringify(data));
    }
    else {
        console.error(`[INFO] ${sanitized}`);
    }
}
export function warn(message, data) {
    const sanitized = redact(message);
    if (data !== undefined) {
        console.error(`[WARN] ${sanitized}`, safeStringify(data));
    }
    else {
        console.error(`[WARN] ${sanitized}`);
    }
}
export function error(message, err) {
    const sanitized = redact(message);
    if (err instanceof Error) {
        console.error(`[ERROR] ${sanitized}:`, redact(err.message));
    }
    else if (err !== undefined) {
        console.error(`[ERROR] ${sanitized}:`, safeStringify(err));
    }
    else {
        console.error(`[ERROR] ${sanitized}`);
    }
}
export function debug(message, data) {
    if (!process.env.DEBUG)
        return;
    const sanitized = redact(message);
    if (data !== undefined) {
        console.error(`[DEBUG] ${sanitized}`, safeStringify(data));
    }
    else {
        console.error(`[DEBUG] ${sanitized}`);
    }
}
