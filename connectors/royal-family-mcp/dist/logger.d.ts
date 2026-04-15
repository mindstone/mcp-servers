/**
 * Sanitized logger utility — logs to stderr (MCP servers must not write to stdout).
 */
export declare function info(message: string, data?: unknown): void;
export declare function warn(message: string, data?: unknown): void;
export declare function error(message: string, err?: unknown): void;
export declare function debug(message: string, data?: unknown): void;
