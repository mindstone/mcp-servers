import { describe, it, expect, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import {
  createElevenLabsHandlers,
  createElevenLabsUnauthorizedHandlers,
} from './helpers/elevenlabs-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY } from './fixtures/elevenlabs-data.js';

describe('Usage stats tool', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('aggregates workspace usage rows into records and totals (FREE)', async () => {
    mswServer.use(...createElevenLabsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('get_usage_stats', {
      days_back: 7,
      interval: 'day',
      group_by: 'product_type',
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.text);
    expect(parsed.ok).toBe(true);
    expect(parsed.row_count).toBe(3);
    expect(parsed.credits_column).toBe('total_usage');
    expect(parsed.rows[0].product_type).toBe('text-to-speech');
    expect(parsed.rows[0].total_usage).toBe(125.5);
    expect(parsed.totals_by_group['text-to-speech']).toBeCloseTo(167.5);
    expect(parsed.totals_by_group.music).toBeCloseTo(78.3);
    expect(parsed.total_credits_used).toBeCloseTo(245.8);
    expect(parsed.cost).toContain('FREE');
  });

  it('returns AUTH_REQUIRED without an API key', async () => {
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: '', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('get_usage_stats', {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain('AUTH_REQUIRED');
  });

  it('returns AUTH_FAILED on invalid credentials', async () => {
    mswServer.use(...createElevenLabsUnauthorizedHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: 'bad-key', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('get_usage_stats', {});
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.text);
    expect(parsed.code).toBe('AUTH_FAILED');
  });
});
