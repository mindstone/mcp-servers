/**
 * Regression tests for HTTP Origin/Host admission, the SDK tool-input element
 * bound, stdio/HTTP compatibility, and request-body handling (`readJsonBody`).
 * Bodies accumulate in memory before SDK validation runs, so any loopback client
 * passing `isLoopbackHost` could OOM the process with an unbounded body.
 * The reader must reject over-limit bodies (and destroy the request) while leaving
 * ordinary JSON-RPC envelopes untouched.
 */

import { Readable } from 'node:stream';
import http from 'node:http';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { CallToolResultSchema, JSONRPCResponseSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FILE_READ_CAPABILITIES } from '../src/file-read-context.js';
import { createInMemoryClientPair, importConnectorModule, makeImageBase64 } from './helpers.js';

type Connector = Awaited<ReturnType<typeof importConnectorModule>>;
const listeners: http.Server[] = [];
const pairs: Awaited<ReturnType<typeof createInMemoryClientPair>>[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const pair of pairs.splice(0)) await pair.close();
  for (const server of listeners.splice(0)) {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

const listen = async (connector: Connector): Promise<number> => {
  const server = http.createServer(connector.handleHttpRequest);
  listeners.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected an ephemeral TCP listener.');
  return address.port;
};

const post = async (
  port: number,
  message: unknown,
  options: { host?: string; headers?: string[]; holdBody?: boolean; contentType?: string } = {},
): Promise<{ status: number; text: string; bodyUnsent: boolean }> => {
  const body = JSON.stringify(message);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, method: 'POST', agent: false,
      headers: [
        'Host', options.host ?? `127.0.0.1:${port}`,
        'Content-Type', options.contentType ?? 'application/json',
        'Accept', 'application/json, text/event-stream',
        'Content-Length', String(Buffer.byteLength(body)),
        ...(options.headers ?? []),
      ],
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8'), bodyUnsent: !req.writableEnded });
        req.destroy();
      });
    });
    req.on('error', reject);
    if (options.holdBody) req.flushHeaders();
    else req.end(body);
  });
};

const rpcResult = (response: { status: number; text: string }): Record<string, unknown> => {
  expect(response.status).toBe(200);
  const data = response.text.split('\n').find(line => line.startsWith('data: '));
  return JSONRPCResponseSchema.parse(JSON.parse(data ? data.slice(6) : response.text)).result;
};

const listRequest = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
const callRequest = (args: Record<string, unknown>, metadata?: Record<string, unknown>, name = 'edit_image') => ({
  jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args, _meta: metadata },
});
const fakeProvider = (format: 'png' | 'jpeg' = 'png') => vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(
  JSON.stringify({ data: [{ b64_json: makeImageBase64(format) }] }),
  { status: 200, headers: { 'Content-Type': 'application/json' } },
));

const expectedTools = [
  {
    name: 'generate_image', title: 'Generate Image',
    description: "Generate one or more images using OpenAI's GPT Image models and save outputs to your workspace.",
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
    _meta: undefined,
  },
  {
    name: 'edit_image', title: 'Edit Image',
    description: 'Edit one or more existing images with OpenAI image editing and save outputs to your workspace.',
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
    _meta: { 'files/readInputs': { version: 1, inputs: [
      { selector: ['image_paths', '*'], base: 'workspace', expandTilde: false },
      { selector: ['mask_path'], base: 'workspace', expandTilde: false },
    ] } },
  },
];

const expectToolIdentity = (result: unknown): void => {
  const { tools } = ListToolsResultSchema.parse(result);
  expect(tools.map(({ name, title, description, annotations, _meta }) => ({ name, title, description, annotations, _meta }))).toEqual(expectedTools);
};

const makeRequest = (chunks: Buffer[]): http.IncomingMessage => {
  const req = Readable.from(chunks) as http.IncomingMessage;
  req.method = 'POST';
  return req;
};

describe('readJsonBody — request body byte bound', () => {
  it('parses an ordinary JSON body', async () => {
    const connector = await importConnectorModule({
      OPENAI_API_KEY: 'sk-test-Acme-read-json-body',
    });
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    await expect(connector.readJsonBody(makeRequest([body]))).resolves.toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
  });

  it('rejects a body over the byte cap instead of buffering it', async () => {
    const connector = await importConnectorModule({
      OPENAI_API_KEY: 'sk-test-Acme-read-json-body-cap',
    });
    // Two chunks that cross the 4 MB cap only in aggregate.
    const req = makeRequest([Buffer.alloc(3 * 1024 * 1024, 1), Buffer.alloc(2 * 1024 * 1024, 1)]);
    await expect(connector.readJsonBody(req)).rejects.toThrow('Request body too large');
    expect(req.destroyed).toBe(true);
  });
});

describe('HTTP admission', () => {
  it.each([
    undefined,
    'http://localhost', 'http://localhost:3210', 'https://localhost', 'https://localhost:3210',
    'http://127.0.0.1', 'http://127.0.0.1:3210', 'https://127.0.0.1', 'https://127.0.0.1:3210',
    'http://[::1]', 'http://[::1]:3210', 'https://[::1]', 'https://[::1]:3210',
  ])('admits Origin %s to normal SDK handling', async origin => {
    const connector = await importConnectorModule({ OPENAI_API_KEY: 'sk-test-Acme-admission' });
    const provider = fakeProvider();
    const port = await listen(connector);
    const response = await post(port, listRequest, { headers: origin === undefined ? [] : ['Origin', origin] });
    expectToolIdentity(rpcResult(response));
    expect(provider).not.toHaveBeenCalled();
  });

  it.each([
    '127.0.0.1', '127.0.0.1:4312', 'localhost', 'localhost:4312', 'LOCALHOST', '[::1]', '[::1]:4312',
  ])('preserves allowed Host %s', async host => {
    const connector = await importConnectorModule();
    const port = await listen(connector);
    expectToolIdentity(rpcResult(await post(port, listRequest, { host })));
  });

  // Current third-party adapter limitation: uppercase Host plus port gets an empty 400; flip this test when fixed upstream.
  it('preserves pre-existing adapter rejection of uppercase Host LOCALHOST:4312 after outer guard admission', async () => {
    const connector = await importConnectorModule({ OPENAI_API_KEY: 'sk-test-Acme-adapter-host' });
    const provider = fakeProvider();
    const host = 'LOCALHOST:4312';
    expect(connector.isLoopbackHost(host)).toBe(true);
    const response = await post(await listen(connector), listRequest, { host });
    expect(response.status).toBe(400);
    expect(response.text).toBe('');
    expect(provider).not.toHaveBeenCalled();
  });

  it.each([
    'attacker.example', 'localhost.attacker.example', '127.0.0.1.attacker.example',
    '0.0.0.0', '127.0.0.2', '::1', 'localhost:123456',
  ])('preserves refused Host %s before reading the body', async host => {
    const connector = await importConnectorModule({ OPENAI_API_KEY: 'sk-test-Acme-host' });
    const provider = fakeProvider();
    const response = await post(await listen(connector), listRequest, { host, holdBody: true });
    expect(response).toEqual({ status: 403, text: 'Forbidden host', bodyUnsent: true });
    expect(provider).not.toHaveBeenCalled();
  });

  it('preserves absent-Host refusal', async () => {
    const connector = await importConnectorModule();
    expect(connector.isLoopbackHost(undefined)).toBe(false);
    expect(connector.isLoopbackHost('')).toBe(false);
  });

  it.each([
    ['null'], [''], ['not an origin'], ['http://[::1'],
    ['chrome-extension://acme'], ['moz-extension://acme'], ['file://'],
    ['https://attacker.example'], ['http://0.0.0.0:3210'], ['http://192.0.2.1:3210'],
    ['http://localhost.attacker.example'], ['http://127.0.0.1.attacker.example'],
    ['http://LOCALHOST'], ['HTTP://localhost'], ['http://localhost/'], ['http://localhost/path'],
    ['http://localhost:80'], ['https://localhost:443'], ['http://localhost:03210'],
    ['http://user@localhost'], ['http://127.1'], ['http://localhost#fragment'],
    ['http://localhost', 'http://localhost'], ['http://localhost', 'https://attacker.example'],
  ].map(origins => ({ origins })))('refuses Origin $origins before any body is sent', async ({ origins }) => {
    const connector = await importConnectorModule({ OPENAI_API_KEY: 'sk-test-Acme-origin' });
    const provider = fakeProvider();
    const headers = origins.flatMap(origin => ['Origin', origin]);
    const response = await post(await listen(connector), callRequest({ prompt: 'Acme image' }, undefined, 'generate_image'), {
      headers, holdBody: true,
    });
    expect(response).toEqual({ status: 403, text: 'Forbidden origin', bodyUnsent: true });
    expect(provider).not.toHaveBeenCalled();
  });

  it.each(['https://attacker.example', 'null'])('refuses traced simple POST from %s before its body is sent', async origin => {
    const connector = await importConnectorModule({ OPENAI_API_KEY: 'sk-test-Acme-simple-post' });
    const provider = fakeProvider();
    const response = await post(await listen(connector), callRequest({ prompt: 'Acme image' }, undefined, 'generate_image'), {
      headers: ['Origin', origin], contentType: 'text/plain;application/json', holdBody: true,
    });
    expect(response).toEqual({ status: 403, text: 'Forbidden origin', bodyUnsent: true });
    expect(provider).not.toHaveBeenCalled();
  });

  it.each([
    { origin: 'https://attacker.example', contentType: 'application/json' },
    { origin: 'null', contentType: 'application/json' },
    { origin: 'https://attacker.example', contentType: 'text/plain;application/json' },
    { origin: 'null', contentType: 'text/plain;application/json' },
  ])('refuses sent POST from $origin with $contentType', async ({ origin, contentType }) => {
    const { connector } = await maximalEdit();
    const provider = fakeProvider();
    const response = await post(await listen(connector), callRequest({ prompt: 'Acme image' }, undefined, 'generate_image'), {
      headers: ['Origin', origin], contentType,
    });
    expect(response).toEqual({ status: 403, text: 'Forbidden origin', bodyUnsent: false });
    expect(provider).not.toHaveBeenCalled();
  });
});

const maximalEdit = async () => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'Acme-http-image-')));
  tempDirs.push(base);
  const workspace = path.join(base, 'workspace');
  const approved = path.join(base, 'approved');
  await fs.mkdir(workspace);
  await fs.mkdir(approved);
  const standaloneBytes = Buffer.from(makeImageBase64(), 'base64');
  const centralBytes = Buffer.from(standaloneBytes);
  centralBytes[centralBytes.length - 1] = 2;
  const imagePaths = Array.from({ length: 4 }, (_, index) => path.join(workspace, `reference-${index}.png`));
  const maskPath = path.join(workspace, 'mask.png');
  const reads = [];
  for (const [index, rawPath] of [...imagePaths, maskPath].entries()) {
    const canonicalPath = path.join(approved, path.basename(rawPath));
    await fs.writeFile(rawPath, standaloneBytes);
    await fs.writeFile(canonicalPath, centralBytes);
    reads.push({ location: index < 4 ? ['image_paths', index] : ['mask_path'], rawPath, canonicalPath });
  }
  const args = {
    prompt: 'Acme edit '.repeat(128), image_paths: imagePaths, mask_path: maskPath,
    size: 'square', quality: 'medium', count: 1, moderation: 'auto',
    output_format: 'jpeg', output_compression: 80, background: 'opaque',
  };
  const metadata = { 'files/readMode': { version: 1, mode: 'central', reads } };
  const connector = await importConnectorModule({
    OPENAI_API_KEY: 'sk-test-Acme-maximal', MCP_WORKSPACE_PATH: workspace,
    MCP_ALLOWED_SYMLINK_ROOTS: '[]', OPENAI_IMAGE_MODEL: 'gpt-image-2.5-sunburst',
  });
  return { connector, args, metadata, standaloneBytes, centralBytes };
};

const expectMultipart = async (body: unknown, bytes: Buffer): Promise<void> => {
  expect(body).toBeInstanceOf(FormData);
  if (!(body instanceof FormData)) throw new Error('Expected multipart image upload.');
  const images = body.getAll('image[]');
  const mask = body.get('mask');
  expect(images).toHaveLength(4);
  for (const file of [...images, mask]) {
    expect(file).toBeInstanceOf(File);
    if (!(file instanceof File)) throw new Error('Expected an image file.');
    expect(Buffer.from(await file.arrayBuffer())).toEqual(bytes);
  }
  expect(body.get('prompt')).toBe('Acme edit '.repeat(128));
  expect(body.get('size')).toBe('1024x1024');
  expect(body.get('quality')).toBe('medium');
  expect(body.get('n')).toBe('1');
  expect(body.get('moderation')).toBe('auto');
  expect(body.get('output_format')).toBe('jpeg');
  expect(body.get('output_compression')).toBe('80');
  expect(body.get('background')).toBe('opaque');
};

describe('SDK compatibility on stdio configuration and HTTP', () => {
  it('preserves maximal central edit and tool identity on the unbounded stdio configuration', async () => {
    const { connector, args, metadata, centralBytes } = await maximalEdit();
    const provider = fakeProvider('jpeg');
    const pair = await createInMemoryClientPair(connector.createServer(), FILE_READ_CAPABILITIES);
    pairs.push(pair);
    expectToolIdentity(await pair.client.listTools());
    const result = await pair.client.callTool({ name: 'edit_image', arguments: args, _meta: metadata });
    expect(result.isError).not.toBe(true);
    expect(provider).toHaveBeenCalledTimes(1);
    await expectMultipart(provider.mock.calls[0]?.[1]?.body, centralBytes);
  });

  it('preserves maximal HTTP edit with full metadata while retaining standalone reads', async () => {
    const { connector, args, metadata, standaloneBytes } = await maximalEdit();
    const provider = fakeProvider('jpeg');
    const port = await listen(connector);
    // Initialization is a separate request; the next POST gets a fresh server.
    rpcResult(await post(port, { jsonrpc: '2.0', id: 0, method: 'initialize', params: {
      protocolVersion: '2025-03-26', clientInfo: { name: 'Acme', version: '1' }, capabilities: FILE_READ_CAPABILITIES,
    } }));
    const listed = ListToolsResultSchema.parse(rpcResult(await post(port, listRequest)));
    expectToolIdentity(listed);
    const properties = listed.tools.find(tool => tool.name === 'edit_image')?.inputSchema.properties;
    expect(Object.keys(properties ?? {}).sort()).toEqual(Object.keys(args).sort());
    expect(properties?.image_paths).toHaveProperty('maxItems', args.image_paths.length);
    const result = CallToolResultSchema.parse(rpcResult(await post(port, callRequest(args, metadata))));
    expect(result.isError).not.toBe(true);
    expect(provider).toHaveBeenCalledTimes(1);
    // The central mappings point outside the workspace to different bytes.
    await expectMultipart(provider.mock.calls[0]?.[1]?.body, standaloneBytes);
    provider.mockClear();
    const denied = CallToolResultSchema.parse(rpcResult(await post(port, callRequest({
      ...args, image_paths: metadata['files/readMode'].reads.slice(0, 4).map(read => read.canonicalPath),
    }, metadata))));
    expect(denied.isError).toBe(true);
    expect(provider).not.toHaveBeenCalled();
  });

  it('preserves all eight scalar generate arguments over HTTP', async () => {
    const { connector } = await maximalEdit();
    const provider = fakeProvider('jpeg');
    const result = CallToolResultSchema.parse(rpcResult(await post(await listen(connector), callRequest({
      prompt: 'Acme image '.repeat(128), size: 'square', quality: 'medium', count: 1,
      moderation: 'auto', output_format: 'jpeg', output_compression: 80, background: 'opaque',
    }, undefined, 'generate_image'))));
    expect(result.isError).not.toBe(true);
    expect(provider).toHaveBeenCalledTimes(1);
  });
});

describe('HTTP SDK element bound', () => {
  it.each([5, 10_000])('rejects %i image paths with the exact SDK element-limit result', async count => {
    const { connector, args, metadata } = await maximalEdit();
    const provider = fakeProvider();
    const result = CallToolResultSchema.parse(rpcResult(await post(await listen(connector), callRequest({
      ...args, image_paths: Array.from({ length: count }, () => args.image_paths[0]),
    }, metadata))));
    expect(result).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'MCP error -32602: Invalid arguments for tool edit_image: arguments contain more than the maximum of 14 elements' }],
    });
    expect(provider).not.toHaveBeenCalled();
  });

  it('retains the distinct Zod max-four rejection below the element bound', async () => {
    const connector = await importConnectorModule({ OPENAI_API_KEY: 'sk-test-Acme-zod' });
    const provider = fakeProvider();
    const result = CallToolResultSchema.parse(rpcResult(await post(await listen(connector), callRequest({
      prompt: 'Acme edit', image_paths: Array.from({ length: 5 }, () => 'unused.png'),
    }))));
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('Array must contain at most 4 element(s)');
    expect(JSON.stringify(result)).not.toContain('arguments contain more than the maximum');
    expect(provider).not.toHaveBeenCalled();
  });

  it('leaves stdio unbounded and distinguishes the option-absent Zod result', async () => {
    const { connector, args, metadata } = await maximalEdit();
    const provider = fakeProvider();
    const pair = await createInMemoryClientPair(connector.createServer(), FILE_READ_CAPABILITIES);
    pairs.push(pair);
    const result = await pair.client.callTool({ name: 'edit_image', arguments: {
      ...args, image_paths: Array.from({ length: 10_000 }, () => args.image_paths[0]),
    }, _meta: metadata });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('Array must contain at most 4 element(s)');
    expect(JSON.stringify(result)).not.toContain('arguments contain more than the maximum');
    expect(provider).not.toHaveBeenCalled();
  });
});
