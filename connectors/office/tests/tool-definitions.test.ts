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

describe('pre-network input validation', () => {
  const callTool = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    return { isError: result.isError === true, text };
  };

  it.each([
    [
      'apply_style: searchText target without searchText',
      'rebel_office_word_apply_style',
      { style: 'Heading 1', target: { type: 'searchText' } },
    ],
    [
      'apply_style: searchText target with empty searchText',
      'rebel_office_word_apply_style',
      { style: 'Heading 1', target: { type: 'searchText', searchText: '' } },
    ],
    [
      'apply_style: paragraphRange target without startParagraph',
      'rebel_office_word_apply_style',
      { style: 'Heading 1', target: { type: 'paragraphRange' } },
    ],
    [
      'delete_shape: shapeId target without shapeId',
      'rebel_office_powerpoint_delete_shape',
      { slideIndex: 1, target: { type: 'shapeId' } },
    ],
    [
      'format_shape: placeholder target without placeholder',
      'rebel_office_powerpoint_format_shape',
      { slideIndex: 1, target: { type: 'placeholder' }, formatting: { name: 'x' } },
    ],
    [
      'format_shape: formatting with no properties',
      'rebel_office_powerpoint_format_shape',
      { slideIndex: 1, target: { type: 'shapeId', shapeId: 's1' }, formatting: {} },
    ],
  ])('rejects %s before any sidecar relay', async (_label, name, args) => {
    const result = await callTool(name as string, args as Record<string, unknown>);
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Input validation error');
  });

  it.each([
    [
      'apply_style: searchText target with searchText',
      'rebel_office_word_apply_style',
      { style: 'Heading 1', target: { type: 'searchText', searchText: 'Quarterly' } },
    ],
    [
      'apply_style: selection target',
      'rebel_office_word_apply_style',
      { style: 'Quote', target: { type: 'selection' } },
    ],
    [
      'apply_style: paragraphRange with startParagraph',
      'rebel_office_word_apply_style',
      { style: 'Normal', target: { type: 'paragraphRange', startParagraph: 0 } },
    ],
    [
      'delete_shape: shapeId target with shapeId',
      'rebel_office_powerpoint_delete_shape',
      { slideIndex: 1, target: { type: 'shapeId', shapeId: 'shape-42' } },
    ],
    [
      'format_shape: valid target and formatting',
      'rebel_office_powerpoint_format_shape',
      {
        slideIndex: 1,
        target: { type: 'placeholder', placeholder: 'title' },
        formatting: { fillColor: '#4472C4' },
      },
    ],
  ])('accepts %s (fails later at the sidecar boundary, not validation)', async (_label, name, args) => {
    const result = await callTool(name as string, args as Record<string, unknown>);
    // No sidecar is configured here, so a schema-valid call must get PAST
    // validation and fail at the sidecar lifecycle instead.
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain('Input validation error');
  });
});
