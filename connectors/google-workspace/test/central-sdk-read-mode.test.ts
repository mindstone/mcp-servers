import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { http, HttpResponse } from 'msw';
import { z } from 'zod';
// Resolve every SDK class from this connector's 0.7 installation.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CallToolResultSchema,
  type CallToolRequest,
  type CallToolResult,
  type ClientCapabilities,
} from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { mswServer } from './fixtures/setup.js';

const capabilities = { experimental: { 'files/readModes': { version: 1 } } };
const emptyCentral = { version: 1, mode: 'central', reads: [] };
const metadataError = 'Negotiated file reads require valid request files/readMode metadata.';
const documentId = 'acme_synthetic_document_1234567890';
const documentArgs = { input: `https://docs.google.com/document/d/${documentId}/edit` };
const approvedBytes = Buffer.from('Acme approved attachment A');
const forgedBytes = Buffer.from('Acme forged attachment B');
const sendResult = { id: 'message_synthetic', threadId: 'thread_synthetic' };

describe('Google SDK request-scoped file read metadata', () => {
  let base: string | undefined;
  let workspace: string;
  let approved: string;
  let forged: string;
  let client: Client | undefined;
  let sdkServer: Server | undefined;
  let clientTransport: InMemoryTransport | undefined;
  let serverTransport: InMemoryTransport | undefined;
  let startupTransport: Transport | undefined;
  let readContext: MockInstance<typeof import('../src/file-read-context.js').fileReadContext>;
  let wireSend: MockInstance<InMemoryTransport['send']>;
  let sendBodies: string[];
  let unexpectedRequests: string[];
  const initialized = vi.fn();

  beforeEach(async () => {
    vi.resetModules();
    initialized.mockClear();
    sendBodies = [];
    unexpectedRequests = [];
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'google-sdk-read-mode-')));
    workspace = path.join(base, 'workspace');
    const credentials = path.join(base, 'credentials');
    fs.mkdirSync(workspace);
    fs.mkdirSync(credentials, { mode: 0o700 });
    approved = path.join(base, 'approved.txt');
    forged = path.join(base, 'forged.txt');
    fs.writeFileSync(approved, approvedBytes);
    fs.writeFileSync(forged, forgedBytes);
    fs.writeFileSync(path.join(base, 'accounts.json'), JSON.stringify({
      accounts: [{ email: 'user@example.com', category: 'work', description: 'Synthetic SDK test account' }],
    }));
    fs.writeFileSync(path.join(credentials, 'user-example-com.token.json'), JSON.stringify({
      access_token: 'synthetic-access-token',
      refresh_token: 'synthetic-refresh-token',
      expiry_date: Date.now() + 60 * 60 * 1000,
      scope: 'https://mail.google.com/',
    }), { mode: 0o600 });
    vi.stubEnv('ACCOUNTS_PATH', path.join(base, 'accounts.json'));
    vi.stubEnv('CREDENTIALS_PATH', credentials);
    vi.stubEnv('GOOGLE_CLIENT_ID', 'synthetic-client-id');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'synthetic-client-secret');
    vi.stubEnv('MCP_WORKSPACE_PATH', workspace);
    vi.stubEnv('GOOGLE_WORKSPACE_DISABLE_REFRESH', '0');

    mswServer.use(
      http.post('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', async ({ request }) => {
        const body = z.object({ raw: z.string() }).parse(await request.json());
        sendBodies.push(Buffer.from(body.raw, 'base64url').toString('utf8'));
        return HttpResponse.json(sendResult);
      }),
      http.all('*', ({ request }) => {
        unexpectedRequests.push(`${request.method} ${request.url}`);
        return HttpResponse.json({ error: 'Unexpected synthetic test request' }, { status: 400 });
      }),
    );

    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    wireSend = vi.spyOn(clientTransport, 'send');
    const connect = Server.prototype.connect;
    // run() owns a private Server; substitute only its unstarted stdio transport.
    vi.spyOn(Server.prototype, 'connect').mockImplementation(function (this: Server, transport) {
      sdkServer = this;
      startupTransport = transport;
      this.oninitialized = initialized;
      if (!serverTransport) throw new Error('Missing paired SDK server transport');
      return connect.call(this, serverTransport);
    });
    const contextModule = await import('../src/file-read-context.js');
    readContext = vi.spyOn(contextModule, 'fileReadContext');
    const { GSuiteServer } = await import('../src/tools/server.js');
    await new GSuiteServer().run();
  });

  afterEach(async () => {
    try {
      await client?.close();
    } finally {
      try {
        await sdkServer?.close();
      } finally {
        try {
          await clientTransport?.close();
        } finally {
          try {
            await serverTransport?.close();
          } finally {
            try {
              await startupTransport?.close();
            } finally {
              client = undefined;
              sdkServer = undefined;
              clientTransport = undefined;
              serverTransport = undefined;
              startupTransport = undefined;
              vi.restoreAllMocks();
              vi.unstubAllEnvs();
              vi.resetModules();
              if (base) fs.rmSync(base, { recursive: true, force: true });
              base = undefined;
            }
          }
        }
      }
    }
  });

  async function initializeClient(clientCapabilities: ClientCapabilities) {
    if (!clientTransport) throw new Error('Missing paired SDK client transport');
    client = new Client({ name: 'synthetic-test-client', version: '1.0.0' }, { capabilities: clientCapabilities });
    await client.connect(clientTransport);
    await client.ping();
    expect(initialized).toHaveBeenCalledTimes(1);
    expect(sdkServer?.getClientCapabilities()).toEqual(clientCapabilities);
    expect(client.getServerCapabilities()?.experimental).toEqual(capabilities.experimental);
    const tools = await client.listTools();
    expect(tools.tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'extract_workspace_document_id', 'send_workspace_email',
    ]));
  }

  async function callTool(params: CallToolRequest['params']) {
    if (!client) throw new Error('SDK client has not initialized');
    const result = await client.request({ method: 'tools/call', params }, CallToolResultSchema);
    expect(wireSend).toHaveBeenCalledWith(expect.objectContaining({ method: 'tools/call', params }));
    expect(unexpectedRequests).toEqual([]);
    return result;
  }

  function resultText(result: CallToolResult) {
    return result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
  }

  function expectSuccess(result: CallToolResult) {
    if (result.isError) {
      // Diagnose the pre-fix RED separately from startup, auth, path or provider failures.
      expect(JSON.parse(resultText(result))).toMatchObject({ ok: false, action_required: metadataError });
      expect(readContext.mock.calls.at(-1)?.[0]).toEqual(capabilities);
      expect(readContext.mock.calls.at(-1)?.[1]).toEqual({ signal: expect.any(AbortSignal) });
      expect(sendBodies).toEqual([]);
    }
    expect(result.isError, resultText(result)).not.toBe(true);
  }

  function centralMetadata(rawPath: string, canonicalPath: string) {
    return { 'files/readMode': {
      version: 1, mode: 'central', reads: [{ location: ['attachments', 0, 'path'], rawPath, canonicalPath }],
    } };
  }

  function sendArgs(rawPath: string) {
    return {
      to: ['recipient@example.com'], subject: 'Synthetic attachment', body: 'Acme test body',
      attachments: [{ path: rawPath }],
      _meta: centralMetadata(rawPath, forged),
    };
  }

  function expectSentBytes(expected: Buffer) {
    expect(sendBodies).toHaveLength(1);
    const parts = sendBodies[0].split(/--boundary_[^\r\n]+\r\n/);
    const attachments = parts.filter(part => part.includes('Content-Disposition: attachment;'));
    expect(attachments).toHaveLength(1);
    const encoded = attachments[0].split('\r\n\r\n')[1]?.split('\r\n--boundary_')[0];
    expect(encoded).toBeDefined();
    expect(Buffer.from(encoded ?? '', 'base64')).toEqual(expected);
    expect(sendBodies[0]).not.toContain(forgedBytes.toString('base64'));
  }

  it.each([
    ['central', emptyCentral],
    ['standalone', { version: 1, mode: 'standalone' }],
  ])('runs a registered no-file tool with negotiated %s request metadata', async (_label, mode) => {
    await initializeClient(capabilities);
    const result = await callTool({
      name: 'extract_workspace_document_id', arguments: documentArgs, _meta: { 'files/readMode': mode },
    });
    expectSuccess(result);
    expect(result.content).toEqual([{ type: 'text', text: `Document ID: ${documentId}` }]);
    expect(sendBodies).toEqual([]);
  });

  it('sends exact outer-authorized ordinary Gmail attachment bytes despite forged arguments._meta', async () => {
    await initializeClient(capabilities);
    const result = await callTool({
      name: 'send_workspace_email', arguments: sendArgs(approved), _meta: centralMetadata(approved, approved),
    });
    expectSuccess(result);
    expect(JSON.parse(resultText(result))).toMatchObject({ messageId: sendResult.id, threadId: sendResult.threadId });
    expectSentBytes(approvedBytes);
  });

  it.each([
    ['missing', undefined],
    ['malformed', { 'files/readMode': { version: 2, mode: 'central', reads: [] } }],
  ])('refuses %s outer metadata before Gmail despite valid forged argument metadata', async (_label, meta) => {
    await initializeClient(capabilities);
    const result = await callTool({ name: 'send_workspace_email', arguments: sendArgs(approved), _meta: meta });
    expect(result.isError).toBe(true);
    expect(JSON.parse(resultText(result))).toMatchObject({ ok: false, action_required: metadataError });
    expect(sendBodies).toEqual([]);
  });

  it('refuses a missing central operand instead of borrowing it from arguments._meta', async () => {
    await initializeClient(capabilities);
    const result = await callTool({
      name: 'send_workspace_email', arguments: sendArgs(approved), _meta: { 'files/readMode': emptyCentral },
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(resultText(result))).toMatchObject({
      action_required: expect.stringContaining('Central file read requires exactly one allowed concrete operand.'),
    });
    expect(sendBodies).toEqual([]);
  });

  it('keeps the registered no-file operation working for an unnegotiated legacy client', async () => {
    await initializeClient({});
    const result = await callTool({ name: 'extract_workspace_document_id', arguments: documentArgs });
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: `Document ID: ${documentId}` }]);
    expect(sendBodies).toEqual([]);
  });

  it('keeps legacy in-workspace Gmail attachment reads on the actual provider path', async () => {
    const local = path.join(workspace, 'local.txt');
    fs.writeFileSync(local, approvedBytes);
    await initializeClient({});
    const result = await callTool({ name: 'send_workspace_email', arguments: sendArgs(local) });
    expect(result.isError, resultText(result)).not.toBe(true);
    expect(JSON.parse(resultText(result))).toMatchObject({ messageId: sendResult.id });
    expectSentBytes(approvedBytes);
  });

  it('keeps legacy workspace containment despite a forged arguments._meta grant', async () => {
    await initializeClient({});
    const result = await callTool({ name: 'send_workspace_email', arguments: sendArgs(approved) });
    expect(result.isError).toBe(true);
    expect(JSON.parse(resultText(result))).toMatchObject({
      action_required: expect.stringContaining('Attachment path must be within the workspace directory.'),
    });
    expect(sendBodies).toEqual([]);
  });
});
