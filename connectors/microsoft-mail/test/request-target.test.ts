import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { Client } from '@microsoft/microsoft-graph-client';
import { mswServer } from './fixtures/setup.js';
import {
  createMicrosoftConfigDir,
  createTestClient,
  type McpTestClient,
  type MicrosoftTestConfig,
} from './fixtures/mcp-test-client.js';

// Every Graph request is recorded by its raw URL so the tests can assert the
// exact request target, and that a refused argument makes no request at all.
let graphUrls: string[] = [];

function recordAllGraphRequests(): void {
  mswServer.use(
    http.all('https://graph.microsoft.com/*', ({ request }) => {
      graphUrls.push(request.url);
      return HttpResponse.json({
        id: 'msg-1',
        conversationId: 'conv-1',
        subject: 'Subject',
        value: [],
      });
    }),
  );
}

function pathOf(url: string): string {
  return new URL(url).pathname;
}

interface ErrorEnvelope {
  ok: boolean;
  error: string;
  action_required: string;
  next_step?: string;
}

describe('microsoft-mail request targets', () => {
  let client: McpTestClient;
  let cfg: MicrosoftTestConfig;

  beforeAll(async () => {
    cfg = createMicrosoftConfigDir();
    client = await createTestClient({
      env: { MS_CLIENT_ID: 'mock-client-id', MS_CONFIG_DIR: cfg.configPath },
    });
  });

  beforeEach(() => {
    graphUrls = [];
    recordAllGraphRequests();
  });

  afterAll(async () => {
    if (client) await client.close();
    if (cfg) cfg.cleanup();
  });

  async function expectRefused(
    tool: string,
    args: Record<string, unknown>,
    field: string,
    hostileMarker: string,
  ): Promise<ErrorEnvelope> {
    const result = await client.callTool(tool, args);
    expect(graphUrls, `raw Graph requests made: ${graphUrls.join(', ')}`).toEqual([]);
    expect(result.isError).toBe(true);
    const json = result.json as ErrorEnvelope;
    expect(json.ok).toBe(false);
    expect(json.error).toContain(`"${field}"`);
    expect(json.error).not.toContain(hostileMarker);
    expect(json.action_required).not.toMatch(/authenticat/i);
    expect(json.next_step).toBeTruthy();
    return json;
  }

  describe('hostile IDs are refused before any Graph request', () => {
    it.each([
      ['../../users/victim/messages/x', 'victim'],
      ['zzmarker?$select=body', 'zzmarker'],
      ['zzmarker#fragment', 'zzmarker'],
      ['%2e%2e', '%2e%2e'],
      ['../mail-dot-segment-marker', 'mail-dot-segment-marker'],
    ])('get_email id %j', async (id, marker) => {
      await expectRefused('get_email', { id }, 'id', marker);
    });

    it('delete_email permanent with a dot-segment id', async () => {
      await expectRefused('delete_email', { id: '../mail-delete-marker', permanent: true }, 'id', 'mail-delete-marker');
    });

    it('reply_to_email with a traversal id', async () => {
      await expectRefused(
        'reply_to_email',
        { id: '../../users/mail-reply-marker/messages/m1', body: 'hi' },
        'id',
        'mail-reply-marker',
      );
    });

    it('forward_email with a query-injecting id', async () => {
      await expectRefused(
        'forward_email',
        { id: 'mail-forward-marker?x=1', to: ['alice@example.com'] },
        'id',
        'mail-forward-marker',
      );
    });

    it('send_draft with a traversal id', async () => {
      await expectRefused('send_draft', { id: 'a/../../mail-send-draft-marker' }, 'id', 'mail-send-draft-marker');
    });

    it('list_attachments with a traversal id', async () => {
      await expectRefused('list_attachments', { id: '../mail-attachment-marker' }, 'id', 'mail-attachment-marker');
    });

    it('download_attachment with a dot-segment attachmentId', async () => {
      await expectRefused(
        'download_attachment',
        { id: 'AAMkAGI2', attachmentId: '../mail-download-marker' },
        'attachmentId',
        'mail-download-marker',
      );
    });

    it.each(['mark_email_read', 'set_email_flag', 'update_draft', 'move_email', 'create_reply_draft'])(
      '%s with a traversal id',
      async (tool) => {
        const extra: Record<string, Record<string, unknown>> = {
          set_email_flag: { flag: 'flagged' },
          update_draft: { subject: 'x' },
          move_email: { destinationFolder: 'inbox' },
        };
        const marker = `mail-${tool}-marker`;
        await expectRefused(tool, { id: `../${marker}`, ...(extra[tool] ?? {}) }, 'id', marker);
      },
    );

    it('get_conversation with a traversal id', async () => {
      await expectRefused('get_conversation', { id: '../mail-conversation-marker' }, 'id', 'mail-conversation-marker');
    });

    it('list_emails with a traversal folder', async () => {
      await expectRefused(
        'list_emails',
        { folder: '../../users/mail-folder-marker/mailFolders/inbox' },
        'folder',
        'mail-folder-marker',
      );
    });
  });

  describe('query values stay one parameter', () => {
    it('list_emails filter cannot add query keys', async () => {
      const filter = "isRead eq false&$select=body&$top=999";
      const result = await client.callTool('list_emails', { filter, top: 5 });
      expect(result.isError).not.toBe(true);
      expect(graphUrls).toHaveLength(1);
      const params = new URL(graphUrls[0]!).searchParams;
      expect(params.get('$filter')).toBe(filter);
      expect(params.getAll('$top')).toEqual(['5']);
      expect(params.get('$select')?.split(',')).not.toContain('body');
    });

    it('get_conversation keeps a percent-encoded quote inside the literal', async () => {
      const result = await client.callTool('get_conversation', {
        conversationId: 'conv-1%27 or true',
      });
      expect(result.isError).not.toBe(true);
      const params = new URL(graphUrls[0]!).searchParams;
      expect(params.get('$filter')).toBe("conversationId eq 'conv-1%27 or true'");
    });

    it('get_conversation cannot add query keys through conversationId', async () => {
      await client.callTool('get_conversation', { conversationId: 'conv-1&$top=999' });
      const params = new URL(graphUrls[0]!).searchParams;
      expect(params.get('$filter')).toBe("conversationId eq 'conv-1&$top=999'");
      expect(params.getAll('$top')).toEqual(['25']);
    });

    it('search_emails sends the query as one $search value', async () => {
      const query = 'budget&$select=body';
      const result = await client.callTool('search_emails', { query });
      expect(result.isError).not.toBe(true);
      const params = new URL(graphUrls[0]!).searchParams;
      expect(params.get('$search')).toBe(`"${query}"`);
      expect(params.get('$select')?.split(',')).not.toContain('body');
    });
  });

  describe('real IDs still reach the same resource', () => {
    it.each(['AAMkAGI2THVSAAA=', 'AAMk+AG/I2_x-y=', 'AQMkADAwATM0MDAAMS1iNTcwLWI2NTEtMDACLTAwCgBGAAAD'])(
      'get_email id %j',
      async (id) => {
        const result = await client.callTool('get_email', { id });
        expect(result.isError).not.toBe(true);
        expect(graphUrls).toHaveLength(1);
        expect(decodeURIComponent(pathOf(graphUrls[0]!))).toBe(`/v1.0/me/messages/${id}`);
      },
    );

    it('sends a Mail ID with reserved characters percent-encoded as one segment', async () => {
      await client.callTool('get_email', { id: 'AAMk+AG/I2_x-y=' });
      expect(pathOf(graphUrls[0]!)).toBe('/v1.0/me/messages/AAMk%2BAG%2FI2_x-y%3D');
    });

    it('download_attachment encodes both IDs', async () => {
      await client.callTool('download_attachment', { id: 'AAMk=', attachmentId: 'AAMkADA1+/=' });
      expect(pathOf(graphUrls[0]!)).toBe('/v1.0/me/messages/AAMk%3D/attachments/AAMkADA1%2B%2F%3D');
    });

    it.each([
      ['Inbox', 'inbox'],
      ['Sent Items', 'sentitems'],
      ['archive', 'archive'],
      ['Junk', 'junkemail'],
    ])('list_emails maps the well-known folder %j to %j', async (folder, wellKnown) => {
      await client.callTool('list_emails', { folder });
      expect(pathOf(graphUrls[0]!)).toBe(`/v1.0/me/mailFolders/${wellKnown}/messages`);
    });

    it('list_emails encodes a folder ID', async () => {
      await client.callTool('list_emails', { folder: 'AAMkAGI2folder=' });
      expect(decodeURIComponent(pathOf(graphUrls[0]!))).toBe(
        '/v1.0/me/mailFolders/AAMkAGI2folder=/messages',
      );
    });
  });
});

describe('Graph SDK query building (pinned)', () => {
  beforeEach(() => {
    graphUrls = [];
    recordAllGraphRequests();
  });

  it('does not encode .filter() or .search() values, so the connector must', async () => {
    const sdk = Client.init({ authProvider: (done) => done(null, 'test-token') });
    await sdk.api('/me/messages').filter('a eq 1&$select=body').search('"x&$top=9"').get();
    const params = new URL(graphUrls[0]!).searchParams;
    expect(params.get('$filter')).toBe('a eq 1');
    expect(params.get('$select')).toBe('body');
    expect(params.get('$top')).toBe('9"');
  });
});
