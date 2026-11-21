import { randomUUID } from 'node:crypto';
import type { ApiResponseDescriptor } from './api-catalog.js';
import { z } from 'zod';
import { unlink } from 'node:fs/promises';
import { binaryRepresentation } from './api-media.mjs';
import { artifactProgress, type ProgressContext, type RetainedOutput } from './api-streaming.js';
import { writeWorkspaceArtifactStream } from './tools/path-safety.js';

/** Bounded MIME framing. Only delimiter lines count; lookalikes remain binary bytes. */
export async function* mixedParts(body: ReadableStream<Uint8Array>, contentType: string, signal: AbortSignal) {
  const suffix = contentType.slice(contentType.indexOf(';'));
  const fields = suffix.match(/;[ \t]*[!#$%&'*+.^_`|~0-9A-Za-z-]+=(?:"[^"\r\n]*"|[!#$%&'*+.^_`|~0-9A-Za-z-]+)[ \t]*/g);
  if (fields?.join('') !== suffix) throw new Error('Invalid multipart parameters.');
  const parameters = fields.filter(field => /^;[ \t]*boundary=/i.test(field));
  if (parameters?.length !== 1) throw new Error('Missing or ambiguous multipart boundary.');
  const boundary = parameters[0].replace(/^;?\s*boundary=/i, '').trim().replace(/^"(.*)"$/, '$1');
  if (!/^[0-9A-Za-z'()+_,.\/:=? -]{1,70}$/.test(boundary) || boundary.endsWith(' ')) throw new Error('Invalid multipart boundary.');
  const marker = Buffer.from(`\r\n--${boundary}`), reader = body.getReader();
  let buffer: Buffer = Buffer.from('\r\n'), fragment: Buffer = Buffer.alloc(0);
  let done = false, closed = false;
  const cancel = () => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  const read = async () => {
    signal.throwIfAborted();
    if (!fragment.length && !done) { const next = await reader.read(); done = Boolean(next.done); fragment = next.value ? Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength) : Buffer.alloc(0); }
    signal.throwIfAborted();
    const length = Math.min(fragment.length, 65536);
    buffer = Buffer.concat([buffer, fragment.subarray(0, length)]); fragment = fragment.subarray(length);
  };
  async function* segment() {
    let search = 0;
    while (true) {
      const index = buffer.indexOf(marker, search);
      if (index >= 0) {
        const end = buffer.indexOf('\r\n', index + marker.length);
        const suffix = buffer.subarray(index + marker.length, end < 0 ? buffer.length : end).toString('latin1');
        if (end < 0 && !done && /^(?:-|--[ \t]*\r?|[ \t]*\r?)$/.test(suffix)) {
          if (index) { yield buffer.subarray(0, index); buffer = buffer.subarray(index); search = 0; continue; }
          if (buffer.length > marker.length + 8192) throw new Error('Multipart delimiter line is too large.');
          await read(); continue;
        }
        if (/^(?:--)?[ \t]*$/.test(suffix) && (end >= 0 || (done && suffix.startsWith('--')))) {
          if (index) yield buffer.subarray(0, index);
          closed = suffix.startsWith('--'); buffer = end < 0 ? Buffer.alloc(0) : buffer.subarray(end + 2); return;
        }
        search = index + marker.length; continue;
      }
      const length = Math.max(0, buffer.length - marker.length + 1);
      if (length) { yield buffer.subarray(0, length); buffer = buffer.subarray(length); }
      if (done) { if (buffer.length) yield buffer; throw new Error('Truncated multipart body.'); }
      search = 0; await read();
    }
  }
  try {
    for await (const _ of segment()) { /* Discard preamble without accumulating it. */ }
    for (let parts = 0; !closed; parts++) {
      if (parts >= 128) throw new Error('Too many multipart parts.');
      let end: number;
      while ((end = buffer.indexOf('\r\n\r\n')) < 0) {
        if (done || buffer.length > 16384) throw new Error('Invalid multipart headers.');
        await read();
      }
      if (end > 16384) throw new Error('Multipart headers are too large.');
      const headers = new Headers();
      for (const line of buffer.subarray(0, end).toString('latin1').split('\r\n')) {
        const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*([^\r\n]*)$/.exec(line);
        if (!match || headers.has(match[1])) throw new Error('Invalid multipart header.');
        headers.set(match[1], match[2]);
      }
      if (!['binary', '8bit', '7bit'].includes(headers.get('content-transfer-encoding')?.trim().toLowerCase() ?? 'binary')) throw new Error('Unsupported multipart transfer encoding.');
      buffer = buffer.subarray(end + 4);
      const chunks = segment();
      yield { media: headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase(), body: new ReadableStream<Uint8Array>({
        async pull(controller) { try { const next = await chunks.next(); if (next.done) controller.close(); else controller.enqueue(next.value); } catch (error) { controller.error(error); } },
      }, { highWaterMark: 0 }) };
    }
    // Epilogue is ignored, but drain it incrementally so transport failures remain failures.
    buffer = Buffer.alloc(0);
    while (!done || fragment.length) { await read(); buffer = Buffer.alloc(0); }
  } finally {
    signal.removeEventListener('abort', cancel);
    try { await reader.cancel(); } finally { reader.releaseLock(); }
  }
}

/** Part headers select metadata or the existing authoritative audio representation/writer. */
export async function materializeMixed(response: Response, descriptor: ApiResponseDescriptor, signal: AbortSignal,
  saved: RetainedOutput[], context?: ProgressContext) {
  if (!response.body) throw new Error('Missing multipart body.');
  const metadata: unknown[] = [], artifacts = [];
  let jsonBytes = 0, ordinal = 0;
  const orderedContext: ProgressContext | undefined = context && { ...context, sendNotification: notification =>
    context.sendNotification({ ...notification, params: { ...notification.params, progress: ++ordinal } }) };
  for await (const part of mixedParts(response.body, response.headers.get('content-type') ?? '', signal)) {
    if (part.media === descriptor.multipart!.metadata) {
      const reader = part.body.getReader(), bytes: Uint8Array[] = [];
      try {
        while (true) {
          const next = await reader.read(); if (next.done) break;
          jsonBytes += next.value.length;
          if (jsonBytes > 4 * 1024 * 1024) throw new Error('Multipart metadata is too large.');
          bytes.push(next.value);
        }
      } finally { reader.releaseLock(); }
      const value = z.record(z.unknown()).parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(bytes))));
      metadata.push(value);
    } else {
      const representation = binaryRepresentation({ media_type: descriptor.multipart!.audio }, part.media);
      if (!representation) throw new Error('Undeclared multipart media type.');
      const progress = artifactProgress(representation.media_type, orderedContext, signal, true);
      try {
        const artifact = { ...await writeWorkspaceArtifactStream(`elevenlabs_${randomUUID()}.${representation.extension}`, part.body, signal, progress), media_type: representation.media_type };
        if (!artifact.size_bytes) { await unlink(artifact.file_path); throw new Error('Empty multipart audio.'); }
        saved.push({ ...artifact, state: 'complete' }); artifacts.push(artifact);
        await progress.finish('complete');
      } catch (error) {
        const retained = progress.retained();
        if (retained && !saved.some(output => output.file_path === retained.file_path)) saved.push(retained);
        throw error;
      }
    }
  }
  if (!metadata.length || !artifacts.length) throw new Error('Missing multipart audio.');
  return { metadata, artifacts };
}
