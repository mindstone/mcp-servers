import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import type { ProgressNotification } from '@modelcontextprotocol/sdk/types.js';
import { createInMemoryTestClient, type McpTestClient } from '@mindstone/mcp-test-harness';
import { executeApiOperation } from '../src/api-executor.js';
import { setApiKey } from '../src/auth.js';
import * as validation from '../src/api-validation.js';
import * as sensitive from '../src/api-sensitive.js';
import * as writer from '../src/tools/path-safety.js';
import { ApiBoundaryError } from '../src/api-catalog.js';
import type { ProgressContext } from '../src/api-streaming.js';
vi.mock('fs', async original => ({ ...await original<typeof import('fs')>() }));
let workspace: string; let pair: McpTestClient | undefined;
const input = { operation_id: 'get_conversation_audio_route', path_params: { conversation_id: 'example' } };
beforeEach(() => {
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stream-executor-'))); vi.stubEnv('MCP_WORKSPACE_PATH', workspace); setApiKey('synthetic-stream-key');
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(new Uint8Array([0, 255, 128]), { headers: { 'Content-Type': 'audio/mpeg' } }));
});
afterEach(async () => { await pair?.close(); pair = undefined; vi.restoreAllMocks(); vi.unstubAllEnvs(); setApiKey(''); fs.rmSync(workspace, { recursive: true, force: true }); });
function receiver() {
  const notifications: ProgressNotification[] = [];
  const context: ProgressContext = { progressToken: 0, sendNotification: async item => { notifications.push(item); } };
  return { context, notifications };
}
it('returns the existing success receipt for identical bytes with or without progress', async () => {
  const { context, notifications } = receiver();
  const plain = await executeApiOperation('read', input);
  const streaming = await executeApiOperation('read', input, undefined, undefined, context);
  expect({ ...streaming, artifact: { ...streaming.artifact, file_path: 'same' } }).toEqual({ ...plain, artifact: { ...plain.artifact, file_path: 'same' } });
  expect(fs.readFileSync(streaming.artifact!.file_path)).toEqual(Buffer.from([0, 255, 128]));
  expect(notifications.map(item => item.params._meta?.['com.mindstone/stream'])).toMatchObject([{ state: 'running', bytes: 3 }, { state: 'complete', bytes: 3 }]);
});

it.each(['receipt', 'schema', 'redaction'])('keeps published output through post-write %s failure and returns a safe typed descriptor', async kind => {
  const { context, notifications } = receiver();
  if (kind === 'receipt') vi.spyOn(validation, 'createSuccessReceipt').mockRejectedValueOnce(new Error('raw provider secret'));
  if (kind === 'schema') {
    const write = writer.writeWorkspaceArtifactStream;
    vi.spyOn(writer, 'writeWorkspaceArtifactStream').mockImplementationOnce(async (...args) => ({ ...await write(...args), size_bytes: -1 }));
  }
  if (kind === 'redaction') {
    vi.spyOn(validation, 'createSuccessReceipt').mockRejectedValueOnce(new ApiBoundaryError('INVALID_RESPONSE', 'raw provider secret', 'private'));
    const create = sensitive.createRedactor;
    vi.spyOn(sensitive, 'createRedactor').mockImplementationOnce(values => { const redactor = create(values); vi.spyOn(redactor, 'wrap').mockImplementation(() => { throw new Error('raw redaction secret'); }); return redactor; });
  }
  const error = await executeApiOperation('read', input, undefined, undefined, context).catch(error => error);
  expect(error).toMatchObject({ code: 'INVALID_RESPONSE', retained_output: { file_path: expect.any(String), size_bytes: 3, media_type: 'audio/mpeg', state: 'incomplete' } });
  expect(fs.readFileSync(error.retained_output.file_path)).toEqual(Buffer.from([0, 255, 128]));
  expect(error.message).not.toContain('raw'); expect(JSON.stringify(error)).not.toContain('secret');
  expect(notifications.map(item => item.params._meta?.['com.mindstone/stream'])).toMatchObject([{ state: 'running' }, { state: 'incomplete' }]);
});

it('preserves no-token post-write failure cleanup', async () => {
  vi.spyOn(validation, 'createSuccessReceipt').mockRejectedValueOnce(new z.ZodError([]));
  await expect(executeApiOperation('read', input)).rejects.toMatchObject({ code: 'INVALID_RESPONSE', retained_output: undefined });
  expect(fs.readdirSync(workspace)).toEqual([]);
});

it('forwards a truthful incomplete descriptor in the terminal model error through the MCP tool handler', async () => {
  const { createServer } = await import('../src/server.js'); pair = await createInMemoryTestClient({ createServer });
  vi.spyOn(validation, 'createSuccessReceipt').mockRejectedValueOnce(new Error('raw provider secret'));
  const progress: unknown[] = [];
  const result = await pair.client.callTool({ name: 'elevenlabs_read_resource', arguments: input }, undefined, { onprogress: item => progress.push(item) });
  expect(result.isError).toBe(true);
  const text = (result.content as { text: string }[])[0].text; const error = JSON.parse(text);
  expect(error.retained_output).toMatchObject({ state: 'incomplete', size_bytes: 3, media_type: 'audio/mpeg' });
  expect(text).toContain(error.retained_output.file_path); expect(text).not.toContain('raw provider secret');
  expect(fs.existsSync(error.retained_output.file_path)).toBe(true); expect(progress).toHaveLength(2);
});

it('preserves cancellation classification and published output if cancellation arrives during receipt creation', async () => {
  const abort = new AbortController(); const receipt = validation.createSuccessReceipt;
  vi.spyOn(validation, 'createSuccessReceipt').mockImplementationOnce(async (...args) => { const result = await receipt(...args); abort.abort(); return result; });
  const { context, notifications } = receiver();
  await expect(executeApiOperation('read', input, undefined, abort.signal, context)).rejects.toMatchObject({ code: 'CANCELLED', retained_output: { state: 'incomplete', size_bytes: 3 } });
  expect(notifications.map(item => item.params._meta?.['com.mindstone/stream'])).toMatchObject([{ state: 'running' }, { state: 'incomplete' }]);
});

it('keeps no-token success and its file when the deadline fires during receipt creation', async () => {
  const deadline = new AbortController();
  vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(deadline.signal);
  const receipt = validation.createSuccessReceipt;
  vi.spyOn(validation, 'createSuccessReceipt').mockImplementationOnce(async (...args) => {
    const result = await receipt(...args);
    deadline.abort(new DOMException('Synthetic deadline', 'TimeoutError'));
    return result;
  });
  const result = await executeApiOperation('read', input);
  expect(fs.readFileSync(result.artifact!.file_path)).toEqual(Buffer.from([0, 255, 128]));
});

it('does not blame the provider for a local write failure after publication', async () => {
  const { context } = receiver();
  vi.spyOn(writer, 'writeWorkspaceArtifactStream').mockImplementationOnce(async (_name, _body, _signal, progress) => {
    const file_path = path.join(workspace, 'partial.mp3'); fs.writeFileSync(file_path, 'abc');
    await progress!.update(file_path, 3);
    throw new Error('raw local disk secret');
  });
  const error = await executeApiOperation('read', input, undefined, undefined, context).catch(error => error);
  expect(error).toMatchObject({ retained_output: { size_bytes: 3 }, message: 'The output could not be completed. The partial output file was kept.' });
  expect(error.message).not.toContain('provider'); expect(JSON.stringify(error)).not.toContain('secret');
});
