import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import {
  createTestClient,
  createMicrosoftConfigDir,
  type McpTestClient,
  type MicrosoftTestConfig,
} from './fixtures/mcp-test-client.js';
import { COMPOSE_EMAIL_RESOURCE_URI } from '../src/compose.js';
import { COMPOSE_EMAIL_HTML } from '../src/resources/compose-email-template.js';

// The `_meta.ui` producer contract is shared with Gmail's
// compose_workspace_email: the host renders any tool result carrying it as an
// interactive MCP-App view, so every field below is load-bearing. Keep these
// assertions field-by-field, not shape-only. Handler-level fail-closed
// validation lives in compose-email-fail-closed.test.ts.

const SENDER = 'sender@example.com';

describe('compose_email producer contract', () => {
  let client: McpTestClient;
  let cfg: MicrosoftTestConfig;

  beforeAll(async () => {
    cfg = createMicrosoftConfigDir();
    client = await createTestClient({
      env: {
        MS_CLIENT_ID: 'mock-client-id',
        MS_CONFIG_DIR: cfg.configPath,
        MS_ACCOUNT_EMAIL: SENDER,
      },
    });
  });

  afterAll(async () => {
    if (client) await client.close();
    if (cfg) cfg.cleanup();
  });

  it('returns the shared _meta.ui contract field-by-field', async () => {
    const to = ['ada@example.com', 'grace@example.com'];
    const cc = ['nia@example.com'];
    const subject = 'Quarterly sync';
    const body = 'Agenda attached.';

    const result = await client.client.callTool({
      name: 'compose_email',
      arguments: { to, cc, subject, body },
    });

    const draftData = { to, cc, bcc: [], subject, body, email: SENDER };

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([
      {
        type: 'text',
        text: `Drafting email to ada@example.com, grace@example.com with subject "Quarterly sync"\n\n${JSON.stringify(draftData)}\n\n[View: ui://microsoft-mail/compose-email]`,
      },
    ]);
    expect(result._meta).toEqual({
      ui: {
        resourceUri: 'ui://microsoft-mail/compose-email',
        presentation: 'primary',
        viewSummary: 'Email draft to ada@example.com, grace@example.com — subject "Quarterly sync".',
        viewRoleLabel: 'Editable email draft',
        structuredFallback: {
          kind: 'email-draft',
          payload: { to, cc, bcc: [], subject, body },
        },
      },
    });
    expect(result.structuredContent).toEqual(draftData);
  });

  it('sanitizes and truncates the viewSummary and fallback payload', async () => {
    const to = ['ada@example.com'];
    const subject = `Hello <b>world</b> \x1b[31mred ${'s'.repeat(150)}`;
    const body = 'b'.repeat(6_000);

    const result = await client.client.callTool({
      name: 'compose_email',
      arguments: { to, subject, body },
    });

    expect(result.isError).toBeFalsy();
    const ui = (result._meta as { ui: Record<string, unknown> }).ui;

    // Tags and ANSI escapes stripped, then truncated to 120 chars ending in an ellipsis.
    const sanitizedSubject = `Hello world red ${'s'.repeat(150)}`;
    const truncatedSubject = `${sanitizedSubject.slice(0, 119)}…`;
    expect(ui.viewSummary).toBe(`Email draft to ada@example.com — subject "${truncatedSubject}".`);

    const fallback = ui.structuredFallback as { kind: string; payload: Record<string, unknown> };
    // Fallback keeps the raw subject (under its 256 cap) and truncates the body at 5000.
    expect(fallback.payload.subject).toBe(subject);
    expect(fallback.payload.body).toBe(`${'b'.repeat(4_999)}…`);

    // structuredContent keeps the full untruncated draft for the iframe.
    expect((result.structuredContent as { body: string }).body).toBe(body);
    expect((result.structuredContent as { cc: string[] }).cc).toEqual([]);
  });

  it('surfaces validation failures as a fail-closed tool error, not an auth envelope', async () => {
    const result = await client.client.callTool({
      name: 'compose_email',
      arguments: { to: ['ada@example.com'], subject: '   ', body: 'hi' },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    expect(text).toContain('compose_email requires non-empty');
    expect(text).not.toContain('auth');
  });

  it('serves the compose-email resource as the committed template HTML', async () => {
    const result = await client.client.readResource({ uri: COMPOSE_EMAIL_RESOURCE_URI });

    expect(result.contents).toHaveLength(1);
    expect(result.contents[0]).toMatchObject({
      uri: 'ui://microsoft-mail/compose-email',
      mimeType: 'text/html',
      text: COMPOSE_EMAIL_HTML,
    });
  });
});
