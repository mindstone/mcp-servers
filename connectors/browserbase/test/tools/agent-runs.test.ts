import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { mswServer } from '../helpers/setup.js';
import {
  createBrowserbaseHandlers,
  MOCK_API_KEY,
  AGENT_ID,
  RUN_ID,
  WAIT_RUN_ID,
  FOREVER_RUN_ID,
  TERMINAL_RUN_ID,
} from '../helpers/browserbase-mock-api.js';
import { createTestClient, type McpTestClient } from '../helpers/mcp-test-client.js';

describe('Agent run tools — Browserbase', () => {
  let testClient: McpTestClient;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  const makeClient = async () => {
    mswServer.use(...createBrowserbaseHandlers());
    testClient = await createTestClient({
      env: { BROWSERBASE_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });
    return testClient;
  };

  it('create_agent_run sends the task and wraps it in the response', async () => {
    const client = await makeClient();
    const result = await client.callTool('create_agent_run', {
      task: 'Go to https://example.com/pricing and return the plans',
      agent_id: AGENT_ID,
      variables: { login_email: { value: 'jane@example.com', description: 'Acme portal login' } },
    });
    const parsed = result.json as { ok: boolean; runId: string; status: string; task: string; message: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe('PENDING');
    expect(parsed.task).toContain('<untrusted-content');
    expect(parsed.message).toContain('wait_for_agent_run');
    // Variable values must never leak into the response.
    expect(JSON.stringify(parsed)).not.toContain('jane@example.com');
  });

  it('list_agent_runs filters and paginates', async () => {
    const client = await makeClient();
    const result = await client.callTool('list_agent_runs', { status: 'RUNNING', agent_id: AGENT_ID });
    const parsed = result.json as { ok: boolean; runs: unknown[]; next_cursor: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.runs).toHaveLength(1);
    expect(parsed.next_cursor).toBe('runs_page_2');
  });

  it('get_agent_run returns the run with wrapped task', async () => {
    const client = await makeClient();
    const result = await client.callTool('get_agent_run', { run_id: RUN_ID });
    const parsed = result.json as { ok: boolean; runId: string; status: string; task: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.runId).toBe(RUN_ID);
    expect(parsed.status).toBe('RUNNING');
    expect(parsed.task).toContain('<untrusted-content');
  });

  it('get_agent_run on a failed run wraps cause.message and neutralises breakout tags', async () => {
    const client = await makeClient();
    const result = await client.callTool('get_agent_run', { run_id: TERMINAL_RUN_ID });
    const parsed = result.json as { ok: boolean; status: string; cause: { code: string; message: string } };
    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe('FAILED');
    expect(parsed.cause.code).toBe('RUNNER_HEARTBEAT_LOST');
    expect(parsed.cause.message).toContain('<\\/untrusted-content>');
    expect(parsed.cause.message.startsWith('<untrusted-content')).toBe(true);
  });

  it('wait_for_agent_run polls until terminal and returns the result', async () => {
    const client = await makeClient();
    const result = await client.callTool('wait_for_agent_run', {
      run_id: WAIT_RUN_ID,
      poll_interval_seconds: 2,
      timeout_seconds: 30,
    });
    expect(result.isError).toBeFalsy();
    const parsed = result.json as {
      ok: boolean;
      status: string;
      result: { plans: Array<{ name: string; price: number }> };
      waited_seconds: number;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe('COMPLETED');
    // run.result is model-authored JSON → string values wrapped.
    expect(parsed.result.plans[0].name).toContain('<untrusted-content');
    expect(parsed.result.plans[0].price).toBe(0);
    expect(typeof parsed.waited_seconds).toBe('number');
  }, 20_000);

  it('wait_for_agent_run returns a TIMEOUT ConnectorError (not silent) when the run never finishes', async () => {
    const client = await makeClient();
    const result = await client.callTool('wait_for_agent_run', {
      run_id: FOREVER_RUN_ID,
      poll_interval_seconds: 2,
      timeout_seconds: 5,
    });
    expect(result.isError).toBe(true);
    const parsed = result.json as { ok: boolean; code: string; resolution: string; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('TIMEOUT');
    expect(parsed.error).toContain('still active');
    expect(parsed.resolution).toContain('get_agent_run');
  }, 20_000);

  it('get_agent_run_messages wraps UIMessage content and preserves roles', async () => {
    const client = await makeClient();
    const result = await client.callTool('get_agent_run_messages', { run_id: RUN_ID });
    const parsed = result.json as {
      ok: boolean;
      messages: Array<{ id: string; message: { role: string; content?: string; parts?: Array<{ type: string; text: string }> } }>;
      next_since: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.messages).toHaveLength(2);
    // Structural fields stay readable…
    expect(parsed.messages[0].message.role).toBe('user');
    expect(parsed.messages[1].message.parts![0].type).toBe('text');
    // …while content is enveloped, with breakout tags neutralised.
    expect(parsed.messages[0].message.content).toContain('<untrusted-content');
    expect(parsed.messages[1].message.parts![0].text).toContain('<\\/untrusted-content>');
    expect(parsed.next_since).toBe('msg_2');
  });

  it('stop_agent_run returns 202 semantics; 409 when the run is already terminal', async () => {
    const client = await makeClient();

    const stopped = await client.callTool('stop_agent_run', { run_id: RUN_ID });
    expect((stopped.json as { ok: boolean; message: string }).message).toContain('202');

    const conflict = await client.callTool('stop_agent_run', { run_id: TERMINAL_RUN_ID });
    expect(conflict.isError).toBe(true);
    const conflictJson = conflict.json as { code: string; resolution: string };
    expect(conflictJson.code).toBe('CONFLICT');
    expect(conflictJson.resolution).toContain('wrong state');
  });

  it('get_agent_run 404 maps to NOT_FOUND with list guidance', async () => {
    const client = await makeClient();
    const result = await client.callTool('get_agent_run', { run_id: 'nonexistent' });
    expect(result.isError).toBe(true);
    const parsed = result.json as { code: string; resolution: string };
    expect(parsed.code).toBe('NOT_FOUND');
    expect(parsed.resolution).toContain('list_agent_runs');
  });
});
