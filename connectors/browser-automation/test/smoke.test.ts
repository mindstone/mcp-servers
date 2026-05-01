import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

// Default tool surface (17 tools): `browser_evaluate` is gated behind
// BROWSER_AUTOMATION_ALLOW_EVAL=1 and does NOT appear in the default
// tools list. See test/eval-gate-and-schemes.test.ts for the gated case.
const EXPECTED_TOOLS = [
  'browser_authenticate',
  'browser_back',
  'browser_click',
  'browser_close',
  'browser_fill',
  'browser_forward',
  'browser_get_page_info',
  'browser_hover',
  'browser_navigate',
  'browser_press_key',
  'browser_screenshot',
  'browser_scroll',
  'browser_select',
  'browser_snapshot',
  'browser_tabs',
  'browser_type',
  'browser_wait',
];

describe('Smoke test — Browser Automation MCP server', () => {
  let testClient: McpTestClient;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  it('should register the default 17 tools via MCP protocol (browser_evaluate gated off)', async () => {
    testClient = await createTestClient();

    const toolsResult = await testClient.client.listTools();
    const toolNames = toolsResult.tools.map(t => t.name).sort();

    expect(toolsResult.tools).toHaveLength(17);
    expect(toolNames).toEqual(EXPECTED_TOOLS);
  });

  it('should have non-empty descriptions for all tools', async () => {
    testClient = await createTestClient();

    const toolsResult = await testClient.client.listTools();
    for (const tool of toolsResult.tools) {
      expect(tool.description, `Tool ${tool.name} should have a description`).toBeTruthy();
      expect(tool.description!.length).toBeGreaterThan(10);
    }
  });

  it('should have annotations on all tools', async () => {
    testClient = await createTestClient();

    const toolsResult = await testClient.client.listTools();

    const readOnlyTools = [
      'browser_snapshot', 'browser_screenshot', 'browser_get_page_info',
      'browser_hover', 'browser_wait',
    ];

    const destructiveTools = [
      'browser_close',
    ];

    for (const tool of toolsResult.tools) {
      expect(tool.annotations, `Tool ${tool.name} should have annotations`).toBeDefined();
      expect(typeof tool.annotations!.readOnlyHint).toBe('boolean');

      if (readOnlyTools.includes(tool.name)) {
        expect(tool.annotations!.readOnlyHint, `${tool.name} should be readOnly`).toBe(true);
      }

      if (destructiveTools.includes(tool.name)) {
        expect(tool.annotations!.destructiveHint, `${tool.name} should be destructive`).toBe(true);
        expect(tool.annotations!.readOnlyHint, `${tool.name} should not be readOnly`).toBe(false);
      }
    }
  });

  it('should have valid inputSchema for all tools', async () => {
    testClient = await createTestClient();

    const toolsResult = await testClient.client.listTools();
    for (const tool of toolsResult.tools) {
      expect(tool.inputSchema, `Tool ${tool.name} should have inputSchema`).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('should have openWorldHint on all tools', async () => {
    testClient = await createTestClient();

    const toolsResult = await testClient.client.listTools();
    for (const tool of toolsResult.tools) {
      expect(tool.annotations, `Tool ${tool.name} should have annotations`).toBeDefined();
      // browser_close is the only tool with openWorldHint: false
      if (tool.name === 'browser_close') {
        expect(tool.annotations!.openWorldHint, `${tool.name} should have openWorldHint: false`).toBe(false);
      } else {
        expect(tool.annotations!.openWorldHint, `${tool.name} should have openWorldHint: true`).toBe(true);
      }
    }
  });

  it('should use snake_case for all top-level parameters', async () => {
    testClient = await createTestClient();

    const toolsResult = await testClient.client.listTools();
    const camelCasePattern = /[a-z][A-Z]/;
    const violations: string[] = [];

    for (const tool of toolsResult.tools) {
      const properties = tool.inputSchema.properties || {};
      for (const paramName of Object.keys(properties as Record<string, unknown>)) {
        if (camelCasePattern.test(paramName)) {
          violations.push(`${tool.name}.${paramName}`);
        }
      }
    }

    expect(violations, `Found camelCase parameters:\n${violations.join('\n')}`).toEqual([]);
  });
});
