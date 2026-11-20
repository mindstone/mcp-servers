import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isRecord, type ApiOperation, type ApiResponseDescriptor } from './api-catalog.js';
import { base64Representation, canonicalAudio } from './api-media.mjs';
import { base64Schema } from './api-schemas.js';
import type { Redactor } from './api-sensitive.js';
import { artifactProgress, type ProgressContext, type RetainedOutput } from './api-streaming.js';
import { jsonArtifactSchema, loadApiValidator } from './api-validation.js';
import { writeWorkspaceArtifactStream } from './tools/path-safety.js';

const maxValueLength = 16 * 1024 * 1024;

/** Lexical framing of a JSON object sequence; JSON.parse checks syntax. Keep at most one value and one transport fragment. */
export async function* jsonValues(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<unknown> {
  const reader = body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let value = '', depth = 0, quoted = false, escaped = false;
  const cancel = () => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      const text = decoder.decode(chunk.value, { stream: !chunk.done });
      let start = 0;
      for (let index = 0; index < text.length; index++) {
        const character = text[index];
        if (!depth) {
          if (/[\x20\t\r\n]/.test(character)) { start = index + 1; continue; }
          if (character !== '{') throw new Error('JSON sequence items must be objects.');
          start = index;
        }
        if (quoted) {
          if (escaped) escaped = false;
          else if (character === '\\') escaped = true;
          else if (character === '"') quoted = false;
        } else if (character === '"') quoted = true;
        else if (character === '{' || character === '[') depth++;
        else if (character === '}' || character === ']') depth--;
        if (!depth) { yield JSON.parse(value + text.slice(start, index + 1)); value = ''; start = index + 1; }
      }
      if (depth) value += text.slice(start);
      if (value.length > maxValueLength) throw new Error('JSON sequence item is too large.');
      if (chunk.done) break;
    }
    if (value) yield JSON.parse(value);
  } finally {
    signal.removeEventListener('abort', cancel);
    try { await reader.cancel(); } finally { reader.releaseLock(); }
  }
}

/** Backpressure from both workspace writers bounds decoded audio and metadata to one item. */
export async function materializeAudioSequence(response: Response, op: ApiOperation, descriptor: ApiResponseDescriptor,
  outputFormat: unknown, parentSignal: AbortSignal, redactor: Redactor, saved: RetainedOutput[], context?: ProgressContext) {
  if (!response.body) throw new Error('Missing JSON sequence body.');
  const representation = base64Representation(descriptor, {}, outputFormat);
  if (!representation) throw new Error('Undeclared audio representation.');
  const cancellation = new AbortController(), signal = AbortSignal.any([parentSignal, cancellation.signal]);
  const validator = await loadApiValidator(), values = jsonValues(response.body, signal);
  const metadata = new TransformStream<Uint8Array, Uint8Array>(), records = metadata.writable.getWriter();
  const encoder = new TextEncoder(), source = `elevenlabs:api:${op.operation_id}`;
  let items = 0;
  const audio = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await values.next();
        if (next.done) {
          if (!items) throw new Error('Empty JSON sequence.');
          await records.close(); controller.close(); return;
        }
        items++;
        if (validator.validateResponse(op, response.status, descriptor.media_type, next.value, redactor) !== 'matched') throw new Error('Invalid JSON sequence item.');
        const item = z.custom<Record<string, unknown>>(isRecord).parse(next.value);
        const field = descriptor.base64_audio!.field;
        const encoded = base64Schema.refine(canonicalAudio).parse(item[field]);
        const record = Object.fromEntries(Object.entries(item).filter(([key]) => key !== field));
        await records.write(encoder.encode(JSON.stringify({ data: redactor.wrap(JSON.stringify(redactor.redact(record, op)), source) }) + '\n'));
        controller.enqueue(Buffer.from(encoded, 'base64'));
      } catch (error) { cancellation.abort(error); controller.error(error); }
    },
    async cancel(reason) { cancellation.abort(reason); await values.return(undefined); },
  }, { highWaterMark: 0 });
  const outputs = [
    { body: audio, extension: representation.extension, media_type: representation.media_type },
    { body: metadata.readable, extension: 'jsonl', media_type: 'application/x-ndjson' },
  ];
  const results = await Promise.allSettled(outputs.map(async (output, index) => {
    const progress = artifactProgress(output.media_type, index === 0 ? context : undefined, signal, true);
    try {
      const artifact = { ...await writeWorkspaceArtifactStream(`elevenlabs_${randomUUID()}.${output.extension}`, output.body, signal, progress),
        media_type: output.media_type, ...(index === 0 && 'format' in representation ? { format: representation.format } : {}) };
      saved.push({ ...artifact, state: 'complete' });
      await progress.finish('complete');
      return index === 0 ? jsonArtifactSchema.parse({ ...artifact, source_path: [descriptor.base64_audio!.field] }) : artifact;
    } catch (error) {
      const retained = progress.retained();
      if (retained && !saved.some(output => output.file_path === retained.file_path)) saved.push(retained);
      cancellation.abort(error); throw error;
    }
  }));
  const failed = results.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
  const [artifact, metadataArtifact] = results.map(result => result.status === 'fulfilled' ? result.value : undefined);
  return { artifact, metadata_artifact: metadataArtifact };
}
