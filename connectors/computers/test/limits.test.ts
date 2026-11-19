import { describe, it, expect } from 'vitest';
import { CommandOutput, OUTPUT_LIMIT, STREAM_REPLY_LIMIT, capSandboxReply, commandOutput, keepingLimitErrors, readCapped } from '../src/limits.js';
import { ConnectorError } from '../src/types.js';

/** A body that hands out the given chunks on demand and records whether the reader cancelled it. */
function source(chunks: Uint8Array[]) {
  const seen = { cancelled: false, pulled: 0 };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks[seen.pulled++];
      if (next) controller.enqueue(next);
      else controller.close();
    },
    cancel() {
      seen.cancelled = true;
    },
  });
  return { stream, seen };
}

const bytes = (n: number, fill = 0x61) => new Uint8Array(n).fill(fill);

function frame(length: number, payload = bytes(Math.min(length, 16))): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  new DataView(out.buffer).setUint32(1, length);
  out.set(payload, 5);
  return out;
}

const sandboxInit = { headers: { 'E2b-Sandbox-Id': 'sb1' } };

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return error instanceof ConnectorError ? error.code : `other: ${(error as Error).message}`;
  }
}

describe('readCapped', () => {
  it('accepts exactly the limit', async () => {
    const { stream } = source([bytes(OUTPUT_LIMIT - 10), bytes(10)]);
    expect((await readCapped(stream, commandOutput)).length).toBe(OUTPUT_LIMIT);
  });

  it('refuses one byte over and cancels the source instead of reading on', async () => {
    const { stream, seen } = source([bytes(OUTPUT_LIMIT), bytes(1), bytes(5), bytes(5)]);
    expect(await code(readCapped(stream, commandOutput))).toBe('OUTPUT_TOO_LARGE');
    expect(seen.cancelled).toBe(true);
    expect(seen.pulled).toBeLessThan(4);
  });

  it('reads nothing from a missing body', async () => {
    expect((await readCapped(null, commandOutput)).length).toBe(0);
  });
});

describe('CommandOutput', () => {
  it('counts stdout and stderr together', () => {
    const over: ConnectorError[] = [];
    const output = new CommandOutput((error) => over.push(error));
    output.add('stdout', Buffer.alloc(OUTPUT_LIMIT / 2, 'a'));
    output.add('stderr', Buffer.alloc(OUTPUT_LIMIT / 2, 'b'));
    expect(over).toHaveLength(0);
    output.add('stderr', 'c');
    output.add('stdout', 'd');
    expect(over.map((e) => e.code)).toEqual(['OUTPUT_TOO_LARGE']);
    expect(output.error?.code).toBe('OUTPUT_TOO_LARGE');
  });

  it('joins a character split across chunks', () => {
    const output = new CommandOutput(() => undefined);
    const euro = Buffer.from('€');
    output.add('stdout', euro.subarray(0, 1));
    output.add('stdout', euro.subarray(1));
    expect(output.stdout).toBe('€');
  });
});

describe('capSandboxReply', () => {
  const connect = (body: ReadableStream<Uint8Array>) => new Response(body, { headers: { 'content-type': 'application/connect+json' } });

  it('leaves replies to anything but a sandbox untouched', async () => {
    const response = new Response('x');
    expect(capSandboxReply('https://api.example.com', {}, response)).toBe(response);
  });

  it('passes a stream of small frames through unchanged', async () => {
    const chunks = [frame(16), frame(16)];
    const { stream } = source(chunks);
    const body = Buffer.from(await capSandboxReply('http://sandbox', sandboxInit, connect(stream)).arrayBuffer());
    expect(body).toEqual(Buffer.concat(chunks));
  });

  it('refuses a frame declared over the limit, even with its header split across chunks after a valid frame', async () => {
    const huge = frame(0xffffffff, new Uint8Array(0));
    const { stream, seen } = source([frame(16), huge.subarray(0, 2), huge.subarray(2), bytes(64)]);
    const result = await code(keepingLimitErrors(async () => {
      try {
        await capSandboxReply('http://sandbox', sandboxInit, connect(stream)).arrayBuffer();
      } catch {
        throw new Error('rewrapped by the SDK');
      }
    }));
    expect(result).toBe('OUTPUT_TOO_LARGE');
    expect(seen.cancelled).toBe(true);
  });

  it('accepts a frame of exactly the limit', async () => {
    const header = frame(OUTPUT_LIMIT, new Uint8Array(0));
    const { stream } = source([header, bytes(OUTPUT_LIMIT)]);
    const body = await capSandboxReply('http://sandbox', sandboxInit, connect(stream)).arrayBuffer();
    expect(body.byteLength).toBe(OUTPUT_LIMIT + 5);
  });

  it('caps an error reply at the output limit, with the header on a Request', async () => {
    const { stream, seen } = source([bytes(OUTPUT_LIMIT), bytes(1), bytes(64), bytes(64), bytes(64)]);
    const request = new Request('http://sandbox/files', sandboxInit);
    const result = await code(keepingLimitErrors(async () => {
      await capSandboxReply(request, undefined, new Response(stream, { status: 500 })).text().catch(() => {
        throw new Error('rewrapped by the SDK');
      });
    }));
    expect(result).toBe('PROVIDER_ERROR');
    expect(seen.cancelled).toBe(true);
  });

  it('recognises a Connect stream whatever the case of its media type, refusing before anything allocates the frame', async () => {
    const huge = frame(0xffffffff, new Uint8Array(0));
    const { stream, seen } = source([huge, bytes(64)]);
    const passed: number[] = [];
    const result = await code(keepingLimitErrors(async () => {
      const response = capSandboxReply('http://sandbox', sandboxInit, new Response(stream, { headers: { 'content-type': 'Application/Connect+Json; charset=utf-8' } }));
      const reader = response.body!.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          passed.push(value.byteLength);
        }
      } catch {
        throw new Error('rewrapped by the SDK');
      }
    }));
    expect(result).toBe('OUTPUT_TOO_LARGE');
    // The header never reaches the SDK, so its decoder never sees the declared length.
    expect(passed).toEqual([]);
    expect(seen.cancelled).toBe(true);
  });

  it('keeps the error-body cap on a reply that claims to be a Connect stream, however small its frames', async () => {
    const frames = Array.from({ length: 64 }, () => frame(64 * 1024, bytes(64 * 1024)));
    const { stream, seen } = source(frames);
    const result = await keepingLimitErrors(async () => {
      await capSandboxReply('http://sandbox/files', sandboxInit, new Response(stream, { status: 500, headers: { 'content-type': 'application/connect+json' } })).text();
    }).catch((error: unknown) => error as ConnectorError);
    expect(result).toMatchObject({ code: 'PROVIDER_ERROR', message: 'E2B sent an error reply too large to read safely.' });
    expect(seen.cancelled).toBe(true);
    expect(seen.pulled).toBeLessThan(frames.length);
  });

  it('caps a successful Connect stream in total, not only frame by frame', async () => {
    const piece = frame(OUTPUT_LIMIT, bytes(OUTPUT_LIMIT));
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(piece);
      },
    });
    const result = await code(keepingLimitErrors(async () => {
      const reader = capSandboxReply('http://sandbox', sandboxInit, connect(stream)).body!.getReader();
      for (;;) if ((await reader.read()).done) break;
    }));
    expect(result).toBe('OUTPUT_TOO_LARGE');
    expect(pulled * piece.length).toBeLessThan(STREAM_REPLY_LIMIT + 3 * OUTPUT_LIMIT);
  });

  it('lets an ordinary error through when no limit was hit', async () => {
    expect(await code(keepingLimitErrors(async () => { throw new Error('boom'); }))).toBe('other: boom');
  });
});
