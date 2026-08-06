import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mswServer } from './helpers/setup.js';
import { createWiseHandlers } from './helpers/wise-mock-server.js';
import {
  createTestClient,
  CONNECTED_ENV,
  type McpTestClient,
  type CallToolResult,
} from './helpers/mcp-test-client.js';

function parseResult(result: CallToolResult): Record<string, unknown> {
  const text = (result.content[0] as { type: 'text'; text: string }).text;
  return JSON.parse(text) as Record<string, unknown>;
}

const CREATE_ARGS = {
  quote_id: '11144c35-9fe8-4c32-b351-0c62b46a9458',
  recipient_id: 777001,
  reference: 'Invoice 1042',
};

/**
 * AGENTS.md security invariant #7: production-impacting writes require an
 * explicit env-var opt-in. Money-movement tools must refuse to run unless
 * WISE_ALLOW_MONEY_MOVEMENT is exactly '1'.
 */
describe('Money-movement gate (invariant #7)', () => {
  let emptyConfigDir: string;

  beforeAll(() => {
    emptyConfigDir = mkdtempSync(join(tmpdir(), 'wise-mcp-gate-'));
  });

  beforeEach(() => {
    mswServer.use(...createWiseHandlers());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(() => {
    rmSync(emptyConfigDir, { recursive: true, force: true });
  });

  async function clientWith(env: Record<string, string>): Promise<McpTestClient> {
    return createTestClient({
      env: { ...CONNECTED_ENV, WISE_CONFIG_PATH: join(emptyConfigDir, 'cfg'), ...env },
    });
  }

  it.each(['create_wise_transfer', 'fund_wise_transfer', 'cancel_wise_transfer'])(
    '%s refuses to run when WISE_ALLOW_MONEY_MOVEMENT is unset',
    async (toolName) => {
      const client = await clientWith({});
      try {
        const args =
          toolName === 'create_wise_transfer' ? CREATE_ARGS : { transfer_id: 888001, profile_id: 12345 };
        const body = parseResult(await client.client.callTool({ name: toolName, arguments: args }));
        expect(body.ok).toBe(false);
        expect(body.code).toBe('WISE_ALLOW_MONEY_MOVEMENT_REQUIRED');
      } finally {
        await client.close();
      }
    },
  );

  it.each(['true', 'yes', 'TRUE', '0', ''])(
    'create_wise_transfer stays gated for WISE_ALLOW_MONEY_MOVEMENT="%s"',
    async (value) => {
      const client = await clientWith({ WISE_ALLOW_MONEY_MOVEMENT: value });
      try {
        const body = parseResult(
          await client.client.callTool({ name: 'create_wise_transfer', arguments: CREATE_ARGS }),
        );
        expect(body.code).toBe('WISE_ALLOW_MONEY_MOVEMENT_REQUIRED');
      } finally {
        await client.close();
      }
    },
  );

  it('create_wise_transfer runs when the gate is exactly "1"', async () => {
    const client = await clientWith({ WISE_ALLOW_MONEY_MOVEMENT: '1' });
    try {
      const body = parseResult(
        await client.client.callTool({ name: 'create_wise_transfer', arguments: CREATE_ARGS }),
      );
      expect(body.ok).toBe(true);
      const transfer = body.transfer as { id: number; customerTransactionId?: string };
      expect(transfer.id).toBe(888002);
      // An auto-generated idempotency key is surfaced for safe retries.
      expect(typeof body.customerTransactionId).toBe('string');
    } finally {
      await client.close();
    }
  });

  it('create_wise_transfer rejects malformed quote ids before any request', async () => {
    const client = await clientWith({ WISE_ALLOW_MONEY_MOVEMENT: '1' });
    try {
      const body = parseResult(
        await client.client.callTool({
          name: 'create_wise_transfer',
          arguments: { ...CREATE_ARGS, quote_id: '../../v1/admin' },
        }),
      );
      expect(body.ok).toBe(false);
      expect(body.code).toBe('INVALID_INPUT');
    } finally {
      await client.close();
    }
  });

  it('fund_wise_transfer completes against the mock', async () => {
    const client = await clientWith({ WISE_ALLOW_MONEY_MOVEMENT: '1' });
    try {
      const body = parseResult(
        await client.client.callTool({
          name: 'fund_wise_transfer',
          arguments: { transfer_id: 888002, profile_id: 12345 },
        }),
      );
      expect(body.ok).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('fund_wise_transfer surfaces REJECTED (HTTP 200) funding failures', async () => {
    const client = await clientWith({ WISE_ALLOW_MONEY_MOVEMENT: '1' });
    try {
      const body = parseResult(
        await client.client.callTool({
          name: 'fund_wise_transfer',
          arguments: { transfer_id: 999, profile_id: 12345 },
        }),
      );
      expect(body.ok).toBe(false);
      expect(body.code).toBe('FUNDING_REJECTED');
      expect(String(body.error)).toContain('enough funds');
    } finally {
      await client.close();
    }
  });

  it('cancel_wise_transfer cancels against the mock', async () => {
    const client = await clientWith({ WISE_ALLOW_MONEY_MOVEMENT: '1' });
    try {
      const body = parseResult(
        await client.client.callTool({ name: 'cancel_wise_transfer', arguments: { transfer_id: 888001 } }),
      );
      expect(body.ok).toBe(true);
      const transfer = body.transfer as { status: string };
      expect(transfer.status).toBe('cancelled');
    } finally {
      await client.close();
    }
  });
});
