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
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const { __test: hooks } = await import('../src/index.js');

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

  it('uses app all on setup validation errors', async () => {
    const result = await callTool('rebel_office_setup', { action: 'bogus' });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.text)).toMatchObject({
      ok: false, app: 'all', action: 'setup', error: { code: 'INVALID_ARGUMENT' },
    });
  });

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
    const parsed = JSON.parse(result.text);
    expect(parsed).toMatchObject({ ok: false, app: (name as string).split('_')[2],
      action: (name as string).split('_').slice(3).join('_'),
      error: { code: 'INVALID_ARGUMENT', retryable: false, fix: expect.any(String) } });
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


it.each(['rebel_office_setup', 'rebel_office_status', 'unknown_tool'])(
  '%s returns the result shape on failure', async (name) => {
    const response = await client.callTool({ name, arguments: {} });
    expect(response.isError).toBe(true);
    if (name === 'rebel_office_status') expect((response.content as Array<{ text: string }>)[0]!.text).not.toContain('rebel_office_setup');
    expect(JSON.parse((response.content as Array<{ text: string }>)[0]!.text)).toMatchObject({
      ok: false, app: name === 'unknown_tool' ? 'office' : 'all', action: name === 'unknown_tool' ? 'unknown' : name.slice('rebel_office_'.length),
      error: { code: name === 'unknown_tool' ? 'INVALID_ARGUMENT' : name === 'rebel_office_status' ? 'SIDECAR_ERROR' : 'SIDECAR_NOT_RUNNING' },
    });
  },
);

describe('handler failures', () => {
  it.each([
    [new TypeError('Unexpected handler bug'), 'INTERNAL_ERROR'],
    ['Unexpected thrown string', 'INTERNAL_ERROR'],
    [new McpError(ErrorCode.InternalError, 'Internal handler error'), 'INTERNAL_ERROR'],
    [new McpError(ErrorCode.InvalidParams, 'Invalid handler argument'), 'INVALID_ARGUMENT'],
  ])('classifies %s as %s', async (error, code) => {
    const tool = hooks.registeredTools.get('rebel_office_word_read_document');
    const original = tool.handler;
    tool.handler = () => { throw error; };
    try {
      const response = await client.callTool({ name: 'rebel_office_word_read_document', arguments: {} });
      expect(response.isError).toBe(true);
      expect(JSON.parse((response.content as Array<{ text: string }>)[0]!.text)).toMatchObject({
        ok: false, app: 'word', action: 'read_document', error: { code },
      });
    } finally {
      tool.handler = original;
    }
  });

  it('classifies a disabled tool as INVALID_ARGUMENT', async () => {
    const tool = hooks.registeredTools.get('rebel_office_word_read_document');
    tool.disable();
    try {
      const response = await client.callTool({ name: 'rebel_office_word_read_document', arguments: {} });
      expect(JSON.parse((response.content as Array<{ text: string }>)[0]!.text).error.code).toBe('INVALID_ARGUMENT');
    } finally {
      tool.enable();
    }
  });

  it.each(['MCP_OFFICE_SIDECAR_DISABLE', 'REBEL_DISABLE_OFFICE_SIDECAR'])(
    'reports setup disabled by %s without suggesting Settings', async (envName) => {
      vi.stubEnv(envName, '1');
      try {
        const response = await client.callTool({ name: 'rebel_office_setup', arguments: {} });
        const result = JSON.parse((response.content as Array<{ text: string }>)[0]!.text);
        expect(response.isError).toBe(true);
        expect(result).toMatchObject({ ok: false, app: 'all', action: 'setup', error: {
          code: 'CONNECTION_DISABLED', retryable: false,
          message: expect.stringContaining('turned off for this Rebel installation'),
          fix: expect.stringContaining('manages this Rebel installation'),
        } });
        expect(result.error.fix).not.toContain('Settings');
        expect(JSON.stringify(result)).not.toContain(envName);
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );
});

it('derives all 60 app identities from their actual sidecar action', async () => {
  const tools = [...hooks.registeredTools].filter(([name]) => /^rebel_office_(word|excel|powerpoint)_/.test(name));
  expect(tools).toHaveLength(60);
  for (const [name, tool] of tools) {
    const dispatch = tool.handler.toString().match(/sidecarRequest\(['"](word|excel|powerpoint)['"],\s*['"]([^'"]+)['"]/);
    expect(dispatch, name).not.toBeNull();
    expect(name).toBe(`rebel_office_${dispatch![1]}_${dispatch![2]}`);
  }
});

it('keeps the public tool names and input schemas unchanged', async () => {
  const { createHash } = await import('node:crypto');
  const surface = [...hooks.registeredTools].map(([name, tool]) => ({ name, inputSchema: tool.inputSchema }));
  expect(createHash('sha256').update(JSON.stringify(surface)).digest('hex')).toMatchInlineSnapshot(`"7e1b1008aa7f7ce03adbbcd53ccc6289ef9684887f7db4d1005224b7ac0044bc"`);
});
