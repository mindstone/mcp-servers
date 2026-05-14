/**
 * Re-exports createBridgeHandlers from the shared test-harness.
 * The bridge mock creates MSW handlers for the MCP host bridge (http://127.0.0.1:{port}/*),
 * returning 401 without a Bearer token and success with one.
 */
export { createBridgeHandlers, type BridgeMockOptions } from '@mindstone/mcp-test-harness';
