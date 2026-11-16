import { createRedactor } from '../src/api-sensitive.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'node:os';
import { join, resolve } from 'node:path';
import { constants as bufferConstants } from 'node:buffer';
import { createInMemoryTestClient, type McpTestClient } from '@mindstone/mcp-test-harness';
import { http, HttpResponse } from 'msw';
import { createServer } from '../src/server.js';
import { FILE_READ_CAPABILITIES } from '../src/file-read-context.js';
import { discoverOperations, loadApiCatalog, validateApiCatalog } from '../src/api-catalog.js';
import { validateRequest } from '../src/api-validation.js';
import { loadCoverageRosters, validatePolicy } from '../scripts/generate-api-catalog.mjs';
import policyInput from '../api/operation-policy.json' with { type: 'json' };
import { apiCatalog } from '../src/generated/api-catalog.js';
import * as auth from '../src/auth.js';
import { mswServer } from './helpers/setup.js';

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync), openSync: vi.fn(actual.openSync) };
});
const ids = ['get_agent_summaries_route', 'post_agent_avatar_route', 'post_agent_hold_audio_route', 'upload_file_route'];
const rosters = await loadCoverageRosters(resolve(import.meta.dirname, '..'));
let base: string;
let workspace: string;
let image: string;
let pair: McpTestClient;
let requests: number;
const countRequest = () => { requests++; };
beforeEach(async () => {
  base = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'agent-media-')));
  workspace = join(base, 'workspace');
  fs.mkdirSync(workspace);
  image = join(workspace, 'avatar.png');
  fs.writeFileSync(image, Buffer.from([137, 80, 78, 71, 0, 128, 255]));
  auth.setApiKey('example-secret-value');
  pair = await createInMemoryTestClient({ createServer, env: { MCP_WORKSPACE_PATH: workspace } });
  requests = 0;
  mswServer.events.on('request:start', countRequest);
});
afterEach(async () => {
  await pair?.close();
  mswServer.events.removeListener('request:start', countRequest);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  auth.setApiKey('');
  fs.rmSync(base, { recursive: true, force: true });
});
function args(file_path = image) {
  return { operation_id: 'post_agent_avatar_route', path_params: { agent_id: 'agent_example' }, files: [{ field: 'avatar_file', file_path }] };
}
function mode(rawPath = image, canonicalPath = image) {
  return { version: 1, mode: 'central', reads: [{ location: ['files', 0, 'file_path'], rawPath, canonicalPath }] };
}
async function call(input: Record<string, unknown>, metadata?: unknown, name = 'elevenlabs_change_resource') {
  return pair.client.callTool({ name, arguments: input, ...(metadata === undefined ? {} : { _meta: { 'files/readMode': metadata } }) });
}
function json(result: Awaited<ReturnType<typeof call>>) {
  const part = result.content.find(part => part.type === 'text');
  if (!part || part.type !== 'text') throw new Error('Missing SDK text result');
  return JSON.parse(part.text) as Record<string, unknown>;
}

describe('agent media contracts', () => {
  it('states effects, deprecated status, callable follow-ups and GET retry checks for all four operations', async () => {
    const catalog = await loadApiCatalog();
    for (const id of ids) {
      const op = catalog.operations.find(op => op.operation_id === id)!;
      expect(op.deprecated).toBe(false);
      expect(catalog.operations.find(read => read.operation_id === op.check_before_retry)).toMatchObject({ profile: 'read', method: 'GET' });
      expect(await discoverOperations({ operation_id: id })).toHaveProperty('contract', expect.stringContaining('"deprecated":false'));
      for (const follow of op.follow_ups) {
        expect(follow).not.toBe(id);
        const read = catalog.operations.find(read => read.operation_id === follow)!;
        await expect(validateRequest('read', { operation_id: follow, path_params: Object.fromEntries(read.parameters.path.required.map(key => [key, 'example_id'])) }, createRedactor([]))).resolves.toMatchObject({ operation_id: follow });
      }
    }
    for (const id of ['post_agent_avatar_route', 'post_agent_hold_audio_route']) {
      expect(await discoverOperations({ operation_id: id })).toMatchObject({ profile: 'change', effects: { destructiveHint: true }, instructions: expect.stringMatching(/replac/i) });
    }
    expect(await discoverOperations({ operation_id: 'upload_file_route' })).toMatchObject({ profile: 'create', effects: { destructiveHint: false }, instructions: expect.stringContaining('unique file ID') });
    const summary = await discoverOperations({ operation_id: 'get_agent_summaries_route' });
    for (const term of ['query_params.agent_ids', 'not test IDs', 'map keyed by agent ID', 'failure details']) expect(summary).toHaveProperty('contract', expect.stringContaining(term));
  });

  it.each([
    ['post_agent_avatar_route', [{ field: 'avatar_file', kind: 'document' }]],
    ['post_agent_hold_audio_route', [{ field: 'hold_audio_file', kind: 'audio', allowed_media_types: ['audio/mpeg', 'audio/wav'] }]],
    ['upload_file_route', [{ field: 'file', kind: ['image', 'document'] }]],
    ['get_agent_summaries_route', [{ field: 'file', kind: 'image' }]],
  ])('refuses unreviewed file binding for %s', (id, file_bindings) => {
    const policy = structuredClone(policyInput);
    Object.assign(policy.operations[id as keyof typeof policy.operations], { file_bindings });
    expect(() => validatePolicy(policy, rosters)).toThrow('reviewed file binding');
  });
  it.each([{ kind: 'video' }, { kind: [] }, { max_bytes: 0 }, { allowed_media_types: [] }])('refuses malformed binding metadata at both boundaries: %j', patch => {
    const policy = structuredClone(policyInput);
    Object.assign(policy.operations.post_agent_avatar_route.file_bindings[0], patch);
    expect(() => validatePolicy(policy, rosters)).toThrow();
    const catalog = structuredClone(apiCatalog);
    Object.assign(catalog.operations.find(op => op.operation_id === 'post_agent_avatar_route')!.request.files![0], patch);
    expect(() => validateApiCatalog(catalog)).toThrow(expect.objectContaining({ code: 'CATALOG_INVALID' }));
  });

  it.each([['guide.pdf', 'application/pdf'], ['guide.txt', 'text/plain'], ['guide.webp', 'image/webp']])('uploads conversation %s with exact bytes and media', async (name, mime) => {
    const file_path = join(workspace, name);
    fs.writeFileSync(file_path, Buffer.from([0, 128, 255]));
    mswServer.use(http.post('https://api.elevenlabs.io/v1/convai/conversations/conv_example/files', async ({ request }) => {
      const form = await request.formData();
      expect([...form.keys()]).toEqual(['file']);
      const file = form.get('file') as File;
      expect(file.type).toBe(mime);
      expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([0, 128, 255]);
      return HttpResponse.json({ file_id: 'file_example' });
    }));
    const result = await call({ operation_id: 'upload_file_route', path_params: { conversation_id: 'conv_example' }, files: [{ field: 'file', file_path }] }, undefined, 'elevenlabs_create_resource');
    expect(json(result)).toMatchObject({ ok: true, response_contract: 'matched' });
    expect(requests).toBe(1);
  });

  it.each(['escape', 'symlink', 'wrong-type', 'directory', 'too-large', 'descriptor-change', 'hold-size', 'hold-type', 'hold-url', 'conversation-audio'])('refuses %s before reading bytes or making a request', async kind => {
    let input: Record<string, unknown> = args();
    let expected = 'INVALID_FILE_TYPE';
    if (kind === 'escape' || kind === 'symlink') {
      const outside = join(base, 'outside.png'); fs.writeFileSync(outside, 'example image');
      const alias = join(workspace, 'alias.png'); fs.symlinkSync(outside, alias);
      input = args(kind === 'escape' ? outside : alias); expected = 'PATH_SANDBOX_VIOLATION';
    } else if (kind === 'directory') input = args(workspace);
    else if (kind === 'wrong-type') { const text = join(workspace, 'image.txt'); fs.writeFileSync(text, 'example'); input = args(text); }
    else if (kind.startsWith('hold') || kind === 'conversation-audio') {
      const file_path = join(workspace, kind === 'hold-type' ? 'hold.ogg' : 'hold.mp3'); fs.writeFileSync(file_path, 'example audio');
      input = { operation_id: 'post_agent_hold_audio_route', path_params: { agent_id: 'agent_example' }, files: [{ field: 'hold_audio_file', file_path }] };
      if (kind === 'conversation-audio') input = { operation_id: 'upload_file_route', path_params: { conversation_id: 'conv_example' }, files: [{ field: 'file', file_path }] };
      if (kind === 'hold-url') { input = { ...input, files: [{ field: 'hold_audio_file', file_path: 'https://example.com/hold.mp3' }] }; expected = 'FILE_NOT_FOUND'; }
      if (kind === 'hold-size') { const stat = fs.statSync(file_path); vi.spyOn(fs, 'statSync').mockReturnValue({ ...stat, size: 40_000_001, isFile: () => true }); expected = 'FILE_TOO_LARGE'; }
    } else if (kind === 'too-large') {
      const stat = fs.statSync(image); vi.spyOn(fs, 'statSync').mockReturnValue({ ...stat, size: bufferConstants.MAX_LENGTH + 1, isFile: () => true }); expected = 'FILE_TOO_LARGE';
    } else {
      const stat = fs.statSync(image); vi.spyOn(fs, 'fstatSync').mockReturnValue({ ...stat, ino: stat.ino + 1, isFile: () => true }); expected = 'FILE_NOT_FOUND';
    }
    const read = vi.mocked(fs.readFileSync).mockClear();
    const result = await call(input, undefined, kind === 'conversation-audio' ? 'elevenlabs_create_resource' : 'elevenlabs_change_resource');
    expect(json(result)).toMatchObject({ ok: false, code: expected });
    if (kind === 'hold-url') expect(JSON.stringify(json(result))).toContain('must be local paths');
    expect(read).not.toHaveBeenCalled();
    expect(requests).toBe(0);
  });
});

describe('image files/readModes authorization', () => {
  beforeEach(async () => {
    await pair.close();
    pair = await createInMemoryTestClient({ createServer, clientCapabilities: FILE_READ_CAPABILITIES, env: { MCP_WORKSPACE_PATH: workspace } });
  });
  it.each([undefined, null, {}, { version: 1, mode: 'denied' }, { version: 1, mode: 'approval_pending' },
    { version: 1, mode: 'central', reads: [] }, { version: 1, mode: 'central', reads: 'invalid' },
    { version: 1, mode: 'central', reads: [{ location: ['files', 1, 'file_path'], rawPath: 'RAW', canonicalPath: 'CANONICAL' }] },
    { version: 1, mode: 'central', reads: [{ location: ['body', 'file_path'], rawPath: 'RAW', canonicalPath: 'CANONICAL' }] },
    { version: 1, mode: 'central', reads: [{ location: ['files', 0, 'file_path'], rawPath: 'wrong', canonicalPath: 'CANONICAL' }] },
  ])('refuses missing or malformed exact operand authorization: %j', async metadata => {
    const actual = metadata === undefined ? undefined : JSON.parse(JSON.stringify(metadata).replaceAll('RAW', image).replaceAll('CANONICAL', image));
    const read = vi.mocked(fs.readFileSync).mockClear(); const open = vi.mocked(fs.openSync).mockClear();
    expect(json(await call(args(), actual))).toMatchObject({ code: 'FILE_AUTHORIZATION_ERROR' });
    expect(read).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled(); expect(requests).toBe(0);
  });
  it('isolates concurrent canonical image operands and accepts explicit standalone mode', async () => {
    const first = join(base, 'first.png'); const second = join(base, 'second.jpg');
    fs.writeFileSync(first, 'example first image'); fs.writeFileSync(second, 'example second image');
    const uploads: string[] = [];
    mswServer.use(http.post('https://api.elevenlabs.io/v1/convai/agents/agent_example/avatar', async ({ request }) => {
      const file = (await request.formData()).get('avatar_file') as File;
      uploads.push(`${file.name}:${file.type}:${await file.text()}`);
      return HttpResponse.json({ agent_id: 'agent_example' });
    }));
    const results = await Promise.all([call(args(first), mode(first, first)), call(args(second), mode(second, second))]);
    expect(results.map(json)).toEqual([expect.objectContaining({ ok: true }), expect.objectContaining({ ok: true })]);
    expect(uploads.sort()).toEqual(['first.png:image/png:example first image', 'second.jpg:image/jpeg:example second image']);
    expect(json(await call(args(), { version: 1, mode: 'standalone' }))).toMatchObject({ ok: true });
    expect(requests).toBe(3);
  });
  it('uses canonical image type and bytes outside the workspace despite a retargeted raw alias; then requires fresh authorization', async () => {
    const approved = join(base, 'approved.png'); fs.writeFileSync(approved, 'example approved image');
    const raw = join(workspace, 'alias.txt'); fs.symlinkSync(approved, raw);
    fs.unlinkSync(raw); fs.symlinkSync(image, raw);
    mswServer.use(http.post('https://api.elevenlabs.io/v1/convai/agents/agent_example/avatar', async ({ request }) => {
      const form = await request.formData(); const file = form.get('avatar_file') as File;
      expect({ name: file.name, type: file.type, bytes: await file.text() }).toEqual({ name: 'approved.png', type: 'image/png', bytes: 'example approved image' });
      return HttpResponse.json({ agent_id: 'agent_example' });
    }));
    expect(json(await call(args(raw), mode(raw, approved)))).toMatchObject({ ok: true, response_contract: 'matched' });
    expect(json(await call(args(raw)))).toMatchObject({ code: 'FILE_AUTHORIZATION_ERROR' });
    const forged = await call({ ...args(raw), _meta: { 'files/readMode': mode(raw, approved) } });
    expect(forged.isError).toBe(true);
    expect(requests).toBe(1);
  });
});
