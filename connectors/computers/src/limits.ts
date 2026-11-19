/**
 * How much the connector will hold in memory from a computer or a provider. Past a limit a reply is
 * refused with a clear error, never cut short: half an answer would look like a whole one.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { ConnectorError } from './types.js';
import { MAX_FILE_BYTES } from './library.js';

/** A command's reply: runner pages are far smaller, so only a misbehaving computer gets near it. */
export const OUTPUT_LIMIT = 1024 * 1024;
/**
 * A successful command stream in total. Output arrives base64-encoded in small JSON frames, so a
 * stream reaching this size must carry well over OUTPUT_LIMIT of output, which is refused first.
 */
export const STREAM_REPLY_LIMIT = 64 * OUTPUT_LIMIT;
/** A provider's own API reply; generous because some lists cover the whole account. */
export const API_REPLY_LIMIT = 16 * 1024 * 1024;

export interface Limit {
  bytes: number;
  error: () => ConnectorError;
}

export function outputTooLarge(): ConnectorError {
  return new ConnectorError(
    'The computer returned too much text to read safely.',
    'OUTPUT_TOO_LARGE',
    'Save command output to a file on the computer, then read smaller sections or copy the file to the Library with computer_copy_out.',
  );
}

/** A reply that is not a success and too large to read: not command output, so not the advice above. */
export function errorReplyTooLarge(provider: string): ConnectorError {
  return new ConnectorError(
    `${provider} sent an error reply too large to read safely.`,
    'PROVIDER_ERROR',
    'Check whether the requested action completed before retrying. If this keeps happening, contact support and include this error.',
  );
}

export function replyTooLarge(provider: string, extraNext = ''): ConnectorError {
  return new ConnectorError(
    `${provider} sent a reply too large to read safely.`,
    'PROVIDER_ERROR',
    `If you were creating, stopping or deleting a computer, check its current state with computer_list before retrying.${extraNext ? ` ${extraNext}` : ''} If the problem continues, contact support and include this error.`,
  );
}

export const commandOutput: Limit = { bytes: OUTPUT_LIMIT, error: outputTooLarge };

/** `extraNext` adds a step for the one call it applies to (for example Fly's organisation-wide app discovery). */
export function providerReply(provider: string, extraNext = ''): Limit {
  return { bytes: API_REPLY_LIMIT, error: () => replyTooLarge(provider, extraNext) };
}

export function fileTooLarge(path: string): ConnectorError {
  return new ConnectorError(`${path} is larger than 200 MB.`, 'FILE_TOO_LARGE', 'Compress or split it on the computer first (for example with zip or split), then copy the parts.');
}

export function fileLimit(path: string): Limit {
  return { bytes: MAX_FILE_BYTES, error: () => fileTooLarge(path) };
}

/** Reads every chunk, counting bytes before keeping them; past the limit it stops the source and throws. */
export async function readCapped(chunks: AsyncIterable<Uint8Array> | null | undefined, limit: Limit): Promise<Buffer> {
  const kept: Uint8Array[] = [];
  let total = 0;
  // Leaving the loop early cancels a web stream and destroys a Node stream.
  for await (const chunk of chunks ?? []) {
    total += chunk.byteLength;
    if (total > limit.bytes) throw limit.error();
    kept.push(chunk);
  }
  return Buffer.concat(kept, total);
}

/** A command's stdout and stderr, kept together up to OUTPUT_LIMIT; past it, `onOver` runs once. */
export class CommandOutput {
  error: ConnectorError | undefined;
  private bytes = 0;
  private readonly parts = { stdout: [] as Buffer[], stderr: [] as Buffer[] };

  constructor(private readonly onOver: (error: ConnectorError) => void) {}

  add(stream: 'stdout' | 'stderr', data: Buffer | string): void {
    if (this.error) return;
    const chunk = typeof data === 'string' ? Buffer.from(data) : data;
    this.bytes += chunk.length;
    if (this.bytes > OUTPUT_LIMIT) {
      this.error = outputTooLarge();
      this.onOver(this.error);
      return;
    }
    this.parts[stream].push(chunk);
  }

  get stdout(): string {
    return Buffer.concat(this.parts.stdout).toString();
  }

  get stderr(): string {
    return Buffer.concat(this.parts.stderr).toString();
  }
}

/**
 * The E2B SDK rewraps any error thrown below it, so a limit tripped in its transport would reach
 * the caller as a generic SDK failure. Each operation gets a slot; the transport records the limit
 * error there, and the operation rethrows it once the SDK has cleaned up.
 */
const limitSlots = new AsyncLocalStorage<{ error?: ConnectorError }>();

export async function keepingLimitErrors<T>(operation: () => Promise<T>): Promise<T> {
  const slot: { error?: ConnectorError } = {};
  try {
    return await limitSlots.run(slot, operation);
  } catch (error) {
    throw slot.error ?? error;
  }
}

/** The limit error the transport recorded for the current operation, if any. */
export function limitErrorSoFar(): ConnectorError | undefined {
  return limitSlots.getStore()?.error;
}

const SANDBOX_HEADER = 'e2b-sandbox-id';

function isSandboxRequest(input: unknown, init?: RequestInit): boolean {
  const own = typeof input === 'object' && input !== null ? (input as { headers?: HeadersInit }).headers : undefined;
  return new Headers(init?.headers).has(SANDBOX_HEADER) || (own !== undefined && new Headers(own).has(SANDBOX_HEADER));
}

/** The media type alone, lowercased, as the Connect SDK compares it. */
function mediaType(response: Response): string {
  return (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
}

/**
 * Bounds what the E2B SDK reads from a computer, below the SDK. Every reply has a total-byte cap:
 * OUTPUT_LIMIT for any non-success reply, whatever its content type; STREAM_REPLY_LIMIT for a
 * successful Connect stream; a file's limit plus headroom for anything else. A Connect stream is
 * also refused, from a frame's 5-byte header, if it declares a frame over OUTPUT_LIMIT, since the
 * SDK allocates the declared length before the payload arrives.
 */
export function capSandboxReply(input: unknown, init: RequestInit | undefined, response: Response): Response {
  if (!response.body || !isSandboxRequest(input, init)) return response;
  const slot = limitSlots.getStore();
  const connect = mediaType(response).startsWith('application/connect+');
  const error = !response.ok ? () => errorReplyTooLarge('E2B') : connect ? outputTooLarge : () => replyTooLarge('E2B');
  const refuse = () => {
    const tripped = error();
    if (slot) slot.error ??= tripped;
    return tripped;
  };
  const total = !response.ok ? OUTPUT_LIMIT : connect ? STREAM_REPLY_LIMIT : MAX_FILE_BYTES + OUTPUT_LIMIT;
  const body = response.body.pipeThrough(guard(total, connect ? OUTPUT_LIMIT : undefined, refuse));
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** Counts every byte against `total`; with `frameLimit`, also reads each Connect frame header as it passes. */
function guard(total: number, frameLimit: number | undefined, refuse: () => ConnectorError): TransformStream<Uint8Array, Uint8Array> {
  let seen = 0;
  // Each frame is 1 flag byte, a 4-byte big-endian length, then that many bytes.
  const header = new Uint8Array(5);
  let have = 0;
  let left = 0;
  return new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > total) throw refuse();
      if (frameLimit !== undefined) {
        for (let i = 0; i < chunk.byteLength; ) {
          if (left > 0) {
            const step = Math.min(left, chunk.byteLength - i);
            left -= step;
            i += step;
            continue;
          }
          header[have++] = chunk[i++];
          if (have === header.length) {
            have = 0;
            left = new DataView(header.buffer).getUint32(1);
            if (left > frameLimit) throw refuse();
          }
        }
      }
      controller.enqueue(chunk);
    },
  });
}
