/**
 * @mindstone/mcp-test-harness
 *
 * Shared test infrastructure for MCP connector packages.
 *
 * Layer 1 (fast, in-process):
 *   - createInMemoryTestClient — InMemoryTransport client-server pair with env stubbing
 *   - setupMswServer — MSW lifecycle hooks (beforeAll/afterEach/afterAll)
 *   - createBridgeHandlers — MSW handlers for host-bridge mock (401 without token, success with)
 *   - createTempConfig — Temp config directory with accounts.json and credentials/
 *
 * Layer 2 (spawned process):
 *   - createStdioTestClient — Spawns connector as child process, connects via stdio
 */

export { createInMemoryTestClient } from './in-memory-client.js';
export type { McpTestClient, CallToolResult, InMemoryTestClientOptions } from './in-memory-client.js';

export { setupMswServer } from './msw-setup.js';

export { createBridgeHandlers } from './bridge-handlers.js';
export type { BridgeMockOptions } from './bridge-handlers.js';

export { createTempConfig } from './temp-config.js';
export type { TempConfigOptions, TempConfigResult } from './temp-config.js';

export { createStdioTestClient } from './stdio-client.js';
export type { StdioTestClientOptions } from './stdio-client.js';

// Shared `<untrusted-content>` envelope helper (AGENTS.md security invariant #6).
// The single canonical home connectors should import from, so the
// check-untrusted-coverage gate has one grep target.
export { wrapUntrusted, wrapUntrustedJsonStrings } from './untrusted-content.js';
