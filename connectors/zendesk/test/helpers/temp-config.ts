/**
 * Re-exports createTempConfig from the shared test-harness.
 * All Zendesk test files should import createTempConfig directly from
 * @mindstone-engineering/mcp-test-harness. This re-export exists only
 * for backwards compatibility.
 */
export { createTempConfig, type TempConfigOptions, type TempConfigResult } from '@mindstone-engineering/mcp-test-harness';
