import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
type ToolHandler<T> = (args: T, extra: unknown) => Promise<CallToolResult>;
/**
 * Wraps a tool handler with standard error handling.
 *
 * - On success: returns the string result as a text content block.
 * - On FathomError: returns a structured JSON error with code and resolution.
 * - On unknown error: returns a generic error message.
 *
 * Secrets are never exposed in error messages.
 */
export declare function withErrorHandling<T>(fn: (args: T, extra: unknown) => Promise<string>): ToolHandler<T>;
export {};
//# sourceMappingURL=utils.d.ts.map