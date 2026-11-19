import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { GcpProvider } from '../src/providers/gcp.js';
import { API_REPLY_LIMIT, OUTPUT_LIMIT } from '../src/limits.js';
import { ConnectorError } from '../src/types.js';
import type { ComputerInfo } from '../src/provider.js';

vi.mock('../src/library.js', async (original) => ({ ...(await original<typeof import('../src/library.js')>()), MAX_FILE_BYTES: 64 * 1024 }));
const FILE_LIMIT = 64 * 1024;

const computer: ComputerInfo = { provider: 'gcp', id: 'computer-one', name: 'one', state: 'running' };

/** A provider whose token and SSH connection are faked; only the code under test runs for real. */
function provider(project = 'acme-proj') {
  const gcp = new GcpProvider({ client_email: 'svc@example.com', private_key: 'unused', project_id: project }, undefined, 'europe-west1-b', 'e2-medium');
  const internals = gcp as unknown as Record<string, unknown>;
  internals.accessToken = async () => 'tok';
  return { gcp, internals };
}

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return error instanceof ConnectorError ? error.code : `other: ${(error as Error).message}`;
  }
}

describe('Google Cloud operation links', () => {
  afterEach(() => vi.unstubAllGlobals());

  function waiting(project: string, replies: unknown[] = [{ status: 'DONE' }]) {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify(replies.shift() ?? { status: 'DONE' }), { status: 200 });
    });
    const { internals } = provider(project);
    const wait = (selfLink: unknown) => (internals.waitOperation as (op: unknown) => Promise<void>).call(internals, { selfLink, status: 'RUNNING' });
    return { urls, wait };
  }

  const accepted: Array<[string, string, string]> = [
    ['zonal', 'acme-proj', 'https://compute.googleapis.com/compute/v1/projects/acme-proj/zones/europe-west1-b/operations/operation-123_abc'],
    ['regional', 'acme-proj', 'https://compute.googleapis.com/compute/v1/projects/acme-proj/regions/europe-west1/operations/op-1'],
    ['global', 'acme-proj', 'https://compute.googleapis.com/compute/v1/projects/acme-proj/global/operations/op-1'],
    ['www host', 'acme-proj', 'https://www.googleapis.com/compute/v1/projects/acme-proj/global/operations/op-1'],
    ['domain-scoped project', 'example.com:acme', 'https://compute.googleapis.com/compute/v1/projects/example.com:acme/global/operations/op-1'],
  ];

  for (const [label, project, link] of accepted) {
    it(`follows a ${label} link, rebuilt on Compute Engine's own address`, async () => {
      const { urls, wait } = waiting(project);
      await wait(link);
      const path = new URL(link).pathname;
      expect(urls).toEqual([`https://compute.googleapis.com${path}/wait`]);
    });
  }

  const base = 'https://compute.googleapis.com/compute/v1/projects/acme-proj/zones/z/operations/op-1';
  const refused: Array<[string, unknown]> = [
    ['another host', 'https://evil.example/compute/v1/projects/acme-proj/zones/z/operations/op-1'],
    ['a suffix host', 'https://compute.googleapis.com.evil.example/compute/v1/projects/acme-proj/zones/z/operations/op-1'],
    ['a trailing-dot host', 'https://compute.googleapis.com./compute/v1/projects/acme-proj/zones/z/operations/op-1'],
    ['an uppercase host', 'https://COMPUTE.googleapis.com/compute/v1/projects/acme-proj/zones/z/operations/op-1'],
    ['another project', 'https://compute.googleapis.com/compute/v1/projects/other-proj/zones/z/operations/op-1'],
    ['a prefix project', 'https://compute.googleapis.com/compute/v1/projects/acme-proj-evil/zones/z/operations/op-1'],
    ['a query', `${base}?alt=json`],
    ['a trailing ?', `${base}?`],
    ['a trailing #', `${base}#`],
    ['a .. segment', 'https://compute.googleapis.com/compute/v1/projects/acme-proj/extra/../zones/z/operations/op-1'],
    ['a . segment', 'https://compute.googleapis.com/compute/v1/projects/acme-proj/./zones/z/operations/op-1'],
    ['an encoded dot', 'https://compute.googleapis.com/compute/v1/projects/acme-proj/%2e%2e/zones/z/operations/op-1'],
    ['an encoded slash', 'https://compute.googleapis.com/compute/v1/projects/acme-proj%2fzones/z/operations/op-1'],
    ['a backslash', 'https://compute.googleapis.com/compute/v1/projects/acme-proj\\zones/z/operations/op-1'],
    ['userinfo', 'https://user@compute.googleapis.com/compute/v1/projects/acme-proj/zones/z/operations/op-1'],
    ['an explicit port', 'https://compute.googleapis.com:443/compute/v1/projects/acme-proj/zones/z/operations/op-1'],
    ['http', 'http://compute.googleapis.com/compute/v1/projects/acme-proj/zones/z/operations/op-1'],
    ['whitespace', `${base} `],
    ['a control character', `${base}\t`],
    ['a relative path', '/compute/v1/projects/acme-proj/zones/z/operations/op-1'],
    ['another kind of resource', 'https://compute.googleapis.com/compute/v1/projects/acme-proj/zones/z/instances/one'],
    ['another API version', 'https://compute.googleapis.com/compute/beta/projects/acme-proj/zones/z/operations/op-1'],
    ['no link at all', undefined],
  ];

  for (const [label, link] of refused) {
    it(`refuses a link with ${label}, sending nothing`, async () => {
      const { urls, wait } = waiting('acme-proj');
      expect(await failure(wait(link))).toBe('PROVIDER_ERROR');
      expect(urls).toEqual([]);
    });
  }

  it('checks the link in every later reply too', async () => {
    const { urls, wait } = waiting('acme-proj', [{ status: 'RUNNING', selfLink: 'https://evil.example/compute/v1/projects/acme-proj/zones/z/operations/op-1' }]);
    expect(await failure(wait(base))).toBe('PROVIDER_ERROR');
    expect(urls).toHaveLength(1);
  });

  it('explains a refused link without blaming the account', async () => {
    const { wait } = waiting('acme-proj');
    const error = await wait('https://evil.example/x').catch((e: unknown) => e as ConnectorError);
    expect(error).toMatchObject({
      message: 'Google Cloud returned an unexpected operation address, so the connector did not follow it.',
      resolution: 'Use computer_list to check whether the requested change completed before trying again. If this keeps happening, contact support and include this error.',
    });
  });
});

describe('Google Cloud reply limits', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('refuses an API reply over the limit and stops reading it', async () => {
    let cancelled = false;
    let sent = 0;
    vi.stubGlobal('fetch', async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1024 * 1024;
        controller.enqueue(new Uint8Array(1024 * 1024).fill(0x20));
      },
      cancel() {
        cancelled = true;
      },
    }), { status: 200 }));
    const { gcp } = provider();
    expect(await failure(gcp.list())).toBe('PROVIDER_ERROR');
    expect(cancelled).toBe(true);
    expect(sent).toBeLessThan(API_REPLY_LIMIT + 4 * 1024 * 1024);
  });
});

/** An SSH channel that sends the given chunks, then closes with `code` unless the connector closed it first. */
function sshWith(chunks: Array<['stdout' | 'stderr', Buffer]>, code = 0) {
  const seen = { closed: false };
  const client = {
    exec(_command: string, callback: (error: Error | undefined, stream: unknown) => void) {
      const stream = Object.assign(new EventEmitter(), {
        stderr: new EventEmitter(),
        close: () => {
          seen.closed = true;
        },
        end: () => {
          setImmediate(() => {
            for (const [which, data] of chunks) {
              if (seen.closed) return;
              (which === 'stdout' ? stream : stream.stderr).emit('data', data);
            }
            stream.emit('close', code);
          });
        },
      });
      callback(undefined, stream);
    },
  };
  return { client, seen };
}

describe('Google Cloud command output', () => {
  it('returns output up to exactly the limit, joining split characters', async () => {
    const euro = Buffer.from('€');
    const { client } = sshWith([
      ['stdout', Buffer.alloc(OUTPUT_LIMIT / 2 - 1, 'a')],
      ['stdout', euro.subarray(0, 1)],
      ['stdout', euro.subarray(1)],
      ['stderr', Buffer.alloc(OUTPUT_LIMIT / 2 - 2, 'b')],
    ], 3);
    const { gcp, internals } = provider();
    internals.connect = async () => client;
    const result = await gcp.exec(computer, 'true', 30);
    expect(result.exitCode).toBe(3);
    expect(result.stdout.endsWith('a€')).toBe(true);
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBe(OUTPUT_LIMIT);
  });

  it('refuses stdout and stderr that together pass the limit, and closes the channel', async () => {
    const { client, seen } = sshWith([
      ['stdout', Buffer.alloc(OUTPUT_LIMIT / 2, 'a')],
      ['stderr', Buffer.alloc(OUTPUT_LIMIT / 2 + 1, 'b')],
      ['stdout', Buffer.alloc(10, 'c')],
    ]);
    const { gcp, internals } = provider();
    internals.connect = async () => client;
    expect(await failure(gcp.exec(computer, 'true', 30))).toBe('OUTPUT_TOO_LARGE');
    expect(seen.closed).toBe(true);
  });
});

describe('Google Cloud downloads', () => {
  function downloading(chunks: Buffer[]) {
    const { client } = sshWith([]);
    const seen = { stream: undefined as Readable | undefined };
    const { gcp, internals } = provider();
    internals.connect = async () => client;
    internals.sftp = async () => ({
      createReadStream: () => {
        seen.stream = Readable.from(chunks, { objectMode: false });
        return seen.stream;
      },
      end: () => undefined,
    });
    return { gcp, seen };
  }

  it('accepts a file of exactly the limit', async () => {
    const { gcp } = downloading([Buffer.alloc(FILE_LIMIT - 1), Buffer.alloc(1)]);
    expect((await gcp.download(computer, '/home/computer/a.bin')).length).toBe(FILE_LIMIT);
  });

  it('counts the bytes it reads and stops one byte over the limit', async () => {
    const { gcp, seen } = downloading([Buffer.alloc(FILE_LIMIT), Buffer.alloc(1), Buffer.alloc(FILE_LIMIT)]);
    expect(await failure(gcp.download(computer, '/home/computer/a.bin'))).toBe('FILE_TOO_LARGE');
    expect(seen.stream?.destroyed).toBe(true);
  });
});
