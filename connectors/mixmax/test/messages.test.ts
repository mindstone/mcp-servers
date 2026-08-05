import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createMixmaxHandlers } from './helpers/mixmax-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

const API_TOKEN = 'test-mixmax-token';

describe('Mixmax message tools', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  async function setup(opts?: { token?: string }) {
    mswServer.use(...createMixmaxHandlers(opts?.token ?? API_TOKEN));
    testClient = await createTestClient({
      env: {
        MIXMAX_API_TOKEN: opts?.token ?? API_TOKEN,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });
  }

  it('list_mixmax_messages returns structured message data', async () => {
    await setup();
    const result = await testClient.callTool('list_mixmax_messages', {});
    const json = result.json as {
      ok: boolean;
      messages: Array<{ _id: string; subject: string; state: string }>;
      count: number;
      hasNext: boolean;
    };

    expect(json.ok).toBe(true);
    expect(json.messages).toHaveLength(2);
    expect(json.count).toBe(2);
    expect(json.messages[0]).toHaveProperty('_id');
    expect(json.messages[0]).toHaveProperty('subject');
    expect(json.hasNext).toBe(false);
  });

  it('list_mixmax_messages envelopes external-text fields', async () => {
    await setup();
    const result = await testClient.callTool('list_mixmax_messages', {});
    const json = result.json as {
      messages: Array<{
        subject: string;
        from: { email: string; name: string };
        to: Array<{ email: string }>;
      }>;
    };

    expect(json.messages[0].subject).toBe(
      '<untrusted-content source="mixmax:message.subject">Quarterly Update</untrusted-content>',
    );
    expect(json.messages[0].from.email).toBe(
      '<untrusted-content source="mixmax:message.from.email">sender@acme.com</untrusted-content>',
    );
    expect(json.messages[0].to[0].email).toBe(
      '<untrusted-content source="mixmax:message.to.email">alice@acme.com</untrusted-content>',
    );
  });

  it('cancel_mixmax_message deletes the scheduled message', async () => {
    let deletedId: string | undefined;
    mswServer.use(
      http.delete('https://api.mixmax.com/v1/messages/:id', ({ request, params }) => {
        const token = request.headers.get('X-API-Token');
        if (token !== API_TOKEN) {
          return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        deletedId = params.id as string;
        return new HttpResponse(null, { status: 200 });
      }),
    );

    testClient = await createTestClient({
      env: { MIXMAX_API_TOKEN: API_TOKEN, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('cancel_mixmax_message', { messageId: 'msg-002' });
    const json = result.json as { ok: boolean; message: string };

    expect(json.ok).toBe(true);
    expect(json.message).toContain('cancelled');
    expect(deletedId).toBe('msg-002');
  });

  it('cancel_mixmax_message surfaces a 404 for an unknown message', async () => {
    await setup();
    const result = await testClient.callTool('cancel_mixmax_message', { messageId: 'msg-unknown' });
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; code: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe('NOT_FOUND');
  });

  it('cancel_mixmax_message rejects empty messageId via Zod', async () => {
    let requestMade = false;
    mswServer.use(
      http.delete('https://api.mixmax.com/v1/messages/*', () => {
        requestMade = true;
        return new HttpResponse(null, { status: 200 });
      }),
    );

    testClient = await createTestClient({
      env: { MIXMAX_API_TOKEN: API_TOKEN, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('cancel_mixmax_message', { messageId: '' });
    expect(result.isError).toBe(true);
    expect(requestMade).toBe(false);
  });

  // --- VAL-B1-MIXMAX-003: send operations ---
  it('send_mixmax_email validates input and sends', async () => {
    let capturedPayload: Record<string, unknown> = {};
    mswServer.use(
      http.post('https://api.mixmax.com/v1/send', async ({ request }) => {
        const token = request.headers.get('X-API-Token');
        if (token !== API_TOKEN) {
          return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        capturedPayload = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ _id: 'msg-new', status: 'sent' });
      }),
    );

    testClient = await createTestClient({
      env: { MIXMAX_API_TOKEN: API_TOKEN, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('send_mixmax_email', {
      to: ['alice@acme.com'],
      subject: 'Test Email',
      body: '<p>Hello Alice!</p>',
      cc: ['manager@acme.com'],
    });
    const json = result.json as { ok: boolean; message: string };

    expect(json.ok).toBe(true);
    expect(json.message).toContain('alice@acme.com');
    expect(capturedPayload.subject).toBe('Test Email');
    expect(capturedPayload.body).toBe('<p>Hello Alice!</p>');
    expect(capturedPayload.to).toEqual([{ email: 'alice@acme.com' }]);
    expect(capturedPayload.cc).toEqual([{ email: 'manager@acme.com' }]);
  });

  it('send_mixmax_email rejects missing required fields via Zod', async () => {
    let requestMade = false;
    mswServer.use(
      http.post('https://api.mixmax.com/v1/send', () => {
        requestMade = true;
        return HttpResponse.json({});
      }),
    );

    testClient = await createTestClient({
      env: { MIXMAX_API_TOKEN: API_TOKEN, MCP_HOST_BRIDGE_STATE: '' },
    });

    // Missing subject
    const result = await testClient.callTool('send_mixmax_email', {
      to: ['alice@acme.com'],
      body: 'Test body',
    });
    expect(result.isError).toBe(true);
    expect(requestMade).toBe(false);
  });

  it('send_mixmax_email rejects invalid email via Zod', async () => {
    let requestMade = false;
    mswServer.use(
      http.post('https://api.mixmax.com/v1/send', () => {
        requestMade = true;
        return HttpResponse.json({});
      }),
    );

    testClient = await createTestClient({
      env: { MIXMAX_API_TOKEN: API_TOKEN, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('send_mixmax_email', {
      to: ['not-an-email'],
      subject: 'Test',
      body: 'Test body',
    });
    expect(result.isError).toBe(true);
    expect(requestMade).toBe(false);
  });
});
