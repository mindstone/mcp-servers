/**
 * Tool-definition contract tests: destructive annotations on mutating tools and
 * pre-network input validation.
 *
 * Drives the real MCP server from `src/index.ts` over an in-memory transport —
 * no sidecar involved. Validation failures must surface as "Input validation
 * error" results BEFORE the handler relays anything to the Office sidecar;
 * the discriminator for "validation passed" is a sidecar-lifecycle error
 * instead (no sidecar is configured in this test environment).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const serverModule = (await import('../src/index.js')) as unknown as {
  __test: {
    server: {
      connect: (transport: unknown) => Promise<void>;
      close: () => Promise<void>;
    };
  };
};

const MUTATING_TOOLS = [
  'rebel_office_word_update_table_cell',
  'rebel_office_word_apply_style',
  'rebel_office_excel_create_pivot_table',
  'rebel_office_excel_refresh_pivot_table',
  'rebel_office_powerpoint_apply_layout',
  'rebel_office_powerpoint_format_shape',
  'rebel_office_powerpoint_delete_shape',
] as const;

let client: Client;

beforeAll(async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await serverModule.__test.server.connect(serverTransport);
  client = new Client({ name: 'tool-definitions-test', version: '0.0.0' });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
  await serverModule.__test.server.close();
});

describe('mutating tool annotations', () => {
  it.each(MUTATING_TOOLS.map((name) => [name] as const))(
    '%s advertises destructiveHint: true',
    async (name) => {
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === name);
      expect(tool, `tool ${name} registered`).toBeDefined();
      expect(tool!.annotations?.readOnlyHint).toBe(false);
      expect(tool!.annotations?.destructiveHint).toBe(true);
    },
  );
});
