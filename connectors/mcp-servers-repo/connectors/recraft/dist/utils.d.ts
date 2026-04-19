import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
type ToolHandler<T> = (args: T, extra: unknown) => Promise<CallToolResult>;
export declare function withErrorHandling<T>(fn: (args: T, extra: unknown) => Promise<string>): ToolHandler<T>;
export {};
//# sourceMappingURL=utils.d.ts.map