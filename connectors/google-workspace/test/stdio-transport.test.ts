import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { STDIO_MAX_MESSAGE_BYTES, createStdioTransport } from '../src/tools/stdio-transport.js';

const ATTACHMENT_LIMIT_BYTES = 25 * 1024 * 1024;
const PIPE_CHUNK_BYTES = 64 * 1024;

function attachmentCallLine(): string {
  const content = Buffer.alloc(ATTACHMENT_LIMIT_BYTES, 0x41).toString('base64');
  const message = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'gmail_upload_attachment', arguments: { content } },
  };
  return `${JSON.stringify(message)}\n`;
}

async function deliver(transport: StdioServerTransport, stdin: PassThrough, line: string) {
  const received: JSONRPCMessage[] = [];
  const errors: Error[] = [];
  let closed = false;
  transport.onmessage = (message) => received.push(message);
  transport.onerror = (error) => errors.push(error);
  transport.onclose = () => { closed = true; };
  await transport.start();
  // Write in pipe-sized chunks, as a real stdio pipe delivers a large message.
  const bytes = Buffer.from(line);
  for (let offset = 0; offset < bytes.length; offset += PIPE_CHUNK_BYTES) {
    stdin.write(bytes.subarray(offset, offset + PIPE_CHUNK_BYTES));
  }
  await new Promise((resolve) => setImmediate(resolve));
  return { received, errors, closed };
}

describe('stdio transport message size', () => {
  const line = attachmentCallLine();

  it('builds a call larger than the SDK default limit and within ours', () => {
    expect(Buffer.byteLength(line)).toBeGreaterThan(10 * 1024 * 1024);
    expect(Buffer.byteLength(line)).toBeLessThan(STDIO_MAX_MESSAGE_BYTES);
  });

  it('accepts a call carrying a base64 attachment at the 25 MiB attachment limit', async () => {
    const stdin = new PassThrough();
    const transport = createStdioTransport(stdin, new PassThrough());
    const { received, errors, closed } = await deliver(transport, stdin, line);

    expect(errors).toEqual([]);
    expect(closed).toBe(false);
    expect(received).toHaveLength(1);
    expect((received[0] as { method?: string }).method).toBe('tools/call');
    await transport.close();
  });

  it('would drop the same call on the SDK default transport', async () => {
    const stdin = new PassThrough();
    const transport = new StdioServerTransport(stdin, new PassThrough());
    const { received, errors, closed } = await deliver(transport, stdin, line);

    expect(received).toHaveLength(0);
    expect(errors.map((error) => error.message).join('\n')).toMatch(/ReadBuffer exceeded/);
    expect(closed).toBe(true);
  });
});
