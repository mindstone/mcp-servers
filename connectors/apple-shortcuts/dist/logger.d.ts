/**
 * Sanitized logger utility
 *
 * NEVER log sensitive data like API keys, tokens, or Authorization headers.
 * This logger automatically redacts common credential patterns.
 */
export declare function info(message: string, data?: unknown): void;
export declare function warn(message: string, data?: unknown): void;
export declare function error(message: string, err?: unknown): void;
export declare function debug(message: string, data?: unknown): void;
