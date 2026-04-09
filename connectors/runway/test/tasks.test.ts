import { describe, it, expect, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createRunwayHandlers } from './helpers/runway-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY } from './fixtures/runway-data.js';

describe('Task management tools', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  describe('check_runway_task', () => {
    it('returns succeeded task with output', async () => {
      mswServer.use(...createRunwayHandlers());
      testClient = await createTestClient({
        env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('check_runway_task', { task_id: 'task-abc-123' });

      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.text);
      expect(data.ok).toBe(true);
      expect(data.task_id).toBe('task-abc-123');
      expect(data.status).toBe('SUCCEEDED');
      expect(data.output).toHaveLength(1);
      expect(data.output[0]).toContain('video.mp4');
    });

    it('returns failed task with error', async () => {
      mswServer.use(...createRunwayHandlers());
      testClient = await createTestClient({
        env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('check_runway_task', { task_id: 'task-fail-456' });

      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.text);
      expect(data.ok).toBe(false);
      expect(data.status).toBe('FAILED');
      expect(data.error).toContain('moderation');
      expect(data.failure_code).toBe('MODERATION_REJECTED');
    });
  });

  describe('wait_for_runway_task', () => {
    it('resolves on succeeded task', async () => {
      mswServer.use(...createRunwayHandlers());
      testClient = await createTestClient({
        env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('wait_for_runway_task', {
        task_id: 'task-abc-123',
        poll_interval: 5,
        timeout: 30,
      });

      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.text);
      expect(data.ok).toBe(true);
      expect(data.status).toBe('SUCCEEDED');
      expect(data.output).toHaveLength(1);
      expect(data.elapsed_seconds).toBeGreaterThanOrEqual(0);
    });

    it('resolves on failed task', async () => {
      mswServer.use(...createRunwayHandlers());
      testClient = await createTestClient({
        env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('wait_for_runway_task', {
        task_id: 'task-fail-456',
        poll_interval: 5,
        timeout: 30,
      });

      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.text);
      expect(data.ok).toBe(false);
      expect(data.status).toBe('FAILED');
    });
  });

  describe('cancel_runway_task', () => {
    it('cancels a task', async () => {
      mswServer.use(...createRunwayHandlers());
      testClient = await createTestClient({
        env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('cancel_runway_task', { task_id: 'task-abc-123' });

      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.text);
      expect(data.ok).toBe(true);
      expect(data.message).toContain('cancelled');
    });
  });
});
