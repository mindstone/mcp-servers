/**
 * Sanitized logger utility
 * 
 * NEVER log sensitive data like API keys, tokens, or Authorization headers.
 * This logger automatically redacts common credential patterns.
 */

// Patterns that indicate sensitive data - redact these
const REDACT_PATTERNS = [
  // Authorization headers (multiple formats)
  /Authorization:\s*[^\s\n]+/gi,
  /"Authorization"\s*:\s*"[^"]+"/gi,  // JSON format
  /Bearer\s+[a-zA-Z0-9\-_.]+/gi,
  
  // Common API key patterns (multiple formats)
  /api[_-]?key[=:]\s*[^\s&"'\n]+/gi,
  /"api[_-]?[kK]ey"\s*:\s*"[^"]+"/gi,  // JSON: "apiKey": "..."
  /token[=:]\s*[^\s&"'\n]+/gi,
  /"token"\s*:\s*"[^"]+"/gi,           // JSON: "token": "..."
  /secret[=:]\s*[^\s&"'\n]+/gi,
  /"secret"\s*:\s*"[^"]+"/gi,          // JSON: "secret": "..."
  /password[=:]\s*[^\s&"'\n]+/gi,
  /"password"\s*:\s*"[^"]+"/gi,        // JSON: "password": "..."
  
  // Specific provider patterns
  /sk-[a-zA-Z0-9]{20,}/g,        // OpenAI
  /ghp_[a-zA-Z0-9]{36}/g,        // GitHub PAT
  /gho_[a-zA-Z0-9]{36}/g,        // GitHub OAuth
  /xoxb-[0-9]+-[a-zA-Z0-9]+/g,   // Slack bot token
  /xoxp-[0-9]+-[a-zA-Z0-9]+/g,   // Slack user token
  /AKIA[0-9A-Z]{16}/g,           // AWS access key
  
  // Private keys
  /-----BEGIN[^-]+PRIVATE KEY-----[\s\S]*?-----END[^-]+PRIVATE KEY-----/g,
];

/**
 * Redact sensitive data from a string
 */
function redact(input: string): string {
  let result = input;
  for (const pattern of REDACT_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

/**
 * Safely stringify a value for logging, redacting sensitive content
 */
function safeStringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return redact(value);
  
  try {
    const str = JSON.stringify(value, null, 2);
    return redact(str);
  } catch {
    return '[Unable to stringify]';
  }
}

/**
 * Log an info message (to stderr for MCP servers)
 */
export function info(message: string, data?: unknown): void {
  const sanitized = redact(message);
  if (data !== undefined) {
    console.error(`[INFO] ${sanitized}`, safeStringify(data));
  } else {
    console.error(`[INFO] ${sanitized}`);
  }
}

/**
 * Log a warning message
 */
export function warn(message: string, data?: unknown): void {
  const sanitized = redact(message);
  if (data !== undefined) {
    console.error(`[WARN] ${sanitized}`, safeStringify(data));
  } else {
    console.error(`[WARN] ${sanitized}`);
  }
}

/**
 * Log an error message
 */
export function error(message: string, err?: unknown): void {
  const sanitized = redact(message);
  if (err instanceof Error) {
    console.error(`[ERROR] ${sanitized}:`, redact(err.message));
  } else if (err !== undefined) {
    console.error(`[ERROR] ${sanitized}:`, safeStringify(err));
  } else {
    console.error(`[ERROR] ${sanitized}`);
  }
}

/**
 * Log a debug message (only when DEBUG env var is set)
 */
export function debug(message: string, data?: unknown): void {
  if (!process.env.DEBUG) return;
  
  const sanitized = redact(message);
  if (data !== undefined) {
    console.error(`[DEBUG] ${sanitized}`, safeStringify(data));
  } else {
    console.error(`[DEBUG] ${sanitized}`);
  }
}
