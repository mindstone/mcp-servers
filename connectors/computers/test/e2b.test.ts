import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Sandbox } from 'e2b';
import { installFetchPolicy } from '../src/fetch-policy.js';
import { E2bProvider } from '../src/providers/e2b.js';
import { OUTPUT_LIMIT } from '../src/limits.js';
import { ConnectorError } from '../src/types.js';
import type { ComputerInfo } from '../src/provider.js';

vi.mock('../src/library.js', async (original) => ({ ...(await original<typeof import('../src/library.js')>()), MAX_FILE_BYTES: 64 * 1024 }));
const FILE_LIMIT = 64 * 1024;

const computer: ComputerInfo = { provider: 'e2b', id: 'sb1', name: 'one', state: 'running' };

/** One Connect stream frame: a flag byte, a 4-byte length, then the message. */
function frame(message: unknown, flags = 0): Buffer {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}
const started = frame({ event: { start: { pid: 7 } } });
const output = (stream: 'stdout' | 'stderr', data: Buffer) => frame({ event: { data: { [stream]: data.toString('base64') } } });
const ended = (exitCode: number) => Buffer.concat([frame({ event: { end: { exitCode, exited: true, status: `exit status ${exitCode}` } } }), frame({}, 2)]);

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
interface Fake {
  start?: Handler;
  startType?: string;
  upload?: Handler;
  read?: Handler;
}

/** Writes `chunks` one per tick until done or the connector hangs up; says whether it hung up. */
function trickle(res: ServerResponse, chunks: Buffer[], end?: Buffer): Promise<boolean> {
  return new Promise((resolve) => {
    let i = 0;
    res.on('close', () => resolve(!res.writableFinished));
    const next = () => {
      if (res.destroyed) return;
      if (i < chunks.length) {
        res.write(chunks[i++]);
        setTimeout(next, 1);
      } else res.end(end);
    };
    next();
  });
}

describe('E2B limits, through the SDK itself', () => {
  let server: Server;
  let fake: Fake = {};
  let kills = 0;
  let starts: string[] = [];
  let e2b: E2bProvider;

  beforeAll(async () => {
    installFetchPolicy();
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/process.Process/Start') {
        let text = '';
        req.on('data', (chunk: Buffer) => (text += chunk.toString('latin1')));
        req.on('end', () => starts.push(text));
      } else req.resume();
      if (url.pathname === '/process.Process/Start') {
        res.writeHead(200, { 'content-type': fake.startType ?? 'application/connect+json' });
        return (fake.start ?? ((_, r) => r.end(Buffer.concat([started, ended(0)]))))(req, res);
      }
      if (url.pathname === '/process.Process/SendSignal') {
        kills++;
        return res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      }
      if (url.pathname === '/files' && req.method === 'POST') {
        return (fake.upload ?? ((_, r) => r.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([{ name: 'x', type: 'file', path: url.searchParams.get('path') }]))))(req, res);
      }
      if (url.pathname === '/files' && req.method === 'GET') return fake.read?.(req, res);
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const sandbox = new (Sandbox as unknown as new (opts: object) => Sandbox)({
      sandboxId: computer.id,
      sandboxUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      envdVersion: '0.5.7',
      apiKey: 'e2b_test',
    });
    e2b = new E2bProvider('e2b_test');
    const internals = e2b as unknown as { sandboxes: Map<string, Sandbox>; lastKeptAwake: Map<string, number> };
    internals.sandboxes.set(computer.id, sandbox);
    internals.lastKeptAwake.set(computer.id, Date.now() + 3600_000);
  });
  afterEach(() => {
    fake = {};
    kills = 0;
    starts = [];
  });
  afterAll(() => server.close());

  async function failure(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
      return 'resolved';
    } catch (error) {
      return error instanceof ConnectorError ? error.code : `other: ${(error as Error).message}`;
    }
  }

  it('returns its own copy of stdout and stderr on a non-zero exit', async () => {
    fake.start = (_, res) => res.end(Buffer.concat([started, output('stdout', Buffer.from('hello\n')), output('stderr', Buffer.from('oops\n')), ended(3)]));
    expect(await e2b.exec(computer, 'false', 30)).toEqual({ exitCode: 3, stdout: 'hello\n', stderr: 'oops\n' });
  });

  it('returns output of exactly the limit', async () => {
    const piece = Buffer.alloc(64 * 1024, 'a');
    const pieces = Array.from({ length: OUTPUT_LIMIT / piece.length }, (_, i) => output(i % 2 ? 'stderr' : 'stdout', piece));
    fake.start = (_, res) => void trickle(res, [started, ...pieces], ended(0));
    const result = await e2b.exec(computer, 'true', 30);
    expect(result.stdout.length + result.stderr.length).toBe(OUTPUT_LIMIT);
  });

  it('refuses output past the limit, hangs up on the stream and kills the command', async () => {
    const piece = Buffer.alloc(64 * 1024, 'a');
    let hungUp: Promise<boolean> = Promise.resolve(false);
    // Far more than the limit, as a computer that ignores the kill would keep sending.
    fake.start = (_, res) => void (hungUp = trickle(res, [started, ...Array.from({ length: 200 }, (_, i) => output(i % 2 ? 'stderr' : 'stdout', piece))], ended(0)));
    const error = await e2b.exec(computer, 'yes', 30).catch((e: unknown) => e as ConnectorError);
    expect(error).toMatchObject({ code: 'OUTPUT_TOO_LARGE', message: 'The computer returned too much text to read safely.' });
    expect(await hungUp).toBe(true);
    await vi.waitFor(() => expect(kills).toBe(1));
    await vi.waitFor(() => expect(starts.some((body) => /rm -f \/tmp\/computer-exec-[0-9a-f]+\.sh"/.test(body))).toBe(true));
  });

  it('refuses a stream frame declared over the limit before reading it', async () => {
    const huge = Buffer.alloc(5);
    huge.writeUInt32BE(0xffffffff, 1);
    let hungUp: Promise<boolean> = Promise.resolve(false);
    fake.start = (_, res) => void (hungUp = trickle(res, [started, output('stdout', Buffer.from('fine\n')), huge.subarray(0, 3), huge.subarray(3), ...Array.from({ length: 50 }, () => Buffer.alloc(1024))]));
    expect(await failure(e2b.exec(computer, 'true', 30))).toBe('OUTPUT_TOO_LARGE');
    expect(await hungUp).toBe(true);
    // The command started, so it is killed and its script removed, as for too much output.
    await vi.waitFor(() => expect(kills).toBe(1));
    await vi.waitFor(() => expect(starts.some((body) => /rm -f \/tmp\/computer-exec-[0-9a-f]+\.sh"/.test(body))).toBe(true));
  });

  it('refuses a mixed-case Connect stream declaring an oversized frame', async () => {
    const huge = Buffer.alloc(5);
    huge.writeUInt32BE(0xffffffff, 1);
    let hungUp: Promise<boolean> = Promise.resolve(false);
    fake.startType = 'Application/Connect+Json';
    fake.start = (_, res) => void (hungUp = trickle(res, [started, huge, ...Array.from({ length: 50 }, () => Buffer.alloc(1024))]));
    expect(await failure(e2b.exec(computer, 'true', 30))).toBe('OUTPUT_TOO_LARGE');
    expect(await hungUp).toBe(true);
  });

  it('caps an error reply to the script upload that claims to be a stream of small frames', async () => {
    fake.upload = (_, res) => {
      res.writeHead(500, { 'content-type': 'application/connect+json' });
      void trickle(res, Array.from({ length: 64 }, () => frame({ pad: 'x'.repeat(64 * 1024) })));
    };
    const error = await e2b.exec(computer, 'true', 30).catch((e: unknown) => e as ConnectorError);
    expect(error).toMatchObject({ code: 'PROVIDER_ERROR', message: 'E2B sent an error reply too large to read safely.' });
  });

  it('refuses an oversized error reply to the script upload before each command', async () => {
    fake.upload = (_, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      void trickle(res, Array.from({ length: 40 }, () => Buffer.alloc(64 * 1024, 'x')));
    };
    expect(await failure(e2b.exec(computer, 'true', 30))).toBe('PROVIDER_ERROR');
  });

  it('accepts a download of exactly the limit', async () => {
    fake.read = (_, res) => res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(Buffer.alloc(FILE_LIMIT));
    expect((await e2b.download(computer, '/home/user/a.bin')).length).toBe(FILE_LIMIT);
  });

  it('counts download bytes as they arrive and stops one byte over', async () => {
    let hungUp: Promise<boolean> = Promise.resolve(false);
    fake.read = (_, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      hungUp = trickle(res, [Buffer.alloc(FILE_LIMIT), Buffer.alloc(1), ...Array.from({ length: 50 }, () => Buffer.alloc(1024))]);
    };
    expect(await failure(e2b.download(computer, '/home/user/a.bin'))).toBe('FILE_TOO_LARGE');
    expect(await hungUp).toBe(true);
  });

  it('refuses an oversized error reply to a download', async () => {
    fake.read = (_, res) => {
      res.writeHead(404, { 'content-type': 'application/json' });
      void trickle(res, Array.from({ length: 40 }, () => Buffer.alloc(64 * 1024, 'x')));
    };
    expect(await failure(e2b.download(computer, '/home/user/a.bin'))).toBe('PROVIDER_ERROR');
  });

  it('still reports a missing file as missing', async () => {
    fake.read = (_, res) => res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 404, message: 'not found' }));
    expect(await failure(e2b.download(computer, '/home/user/none.bin'))).toBe('SOURCE_MISSING');
  });
});
