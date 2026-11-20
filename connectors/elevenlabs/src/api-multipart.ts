import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ApiExecutionInput } from './api-validation.js';
import { ApiBoundaryError, type ApiOperation } from './api-catalog.js';
import type { FileReadContext } from './file-read-context.js';
import { fileMimeTypeForFileName, openSandboxedUpload } from './tools/file-input.js';
import { wrapUntrusted } from './untrusted-content.js';
import { ElevenLabsError } from './types.js';

type Upload = Awaited<ReturnType<typeof openSandboxedUpload>>;
// Match FormData's quoted header parameter escaping; never interpolate raw filenames.
const quote = (value: string) => value.replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/"/g, '%22');
export async function multipartUpload(op: ApiOperation, input: ApiExecutionInput, context: FileReadContext | undefined, signal: AbortSignal) {
  const boundary = `elevenlabs-${randomUUID()}`;
  const parts: { header: Buffer; value: string | Upload }[] = [];
  const uploads: Upload[] = [];
  let stream: Readable | undefined;
  const close = async () => { stream?.destroy(); await Promise.all(uploads.map(upload => upload.close())); };
  const abort = () => { void close().catch(() => stream?.destroy(new ElevenLabsError('The upload could not be closed.', 'FILE_UNREADABLE', 'The request was not retried.'))); };
  const append = (field: string, value: string | Upload, kind?: Parameters<typeof fileMimeTypeForFileName>[1]) => {
    const disposition = `--${boundary}\r\nContent-Disposition: form-data; name="${quote(field)}"`;
    const suffix = typeof value === 'string' ? '' : `; filename="${quote(value.fileName)}"\r\nContent-Type: ${fileMimeTypeForFileName(value.fileName, kind!)}`;
    parts.push({ header: Buffer.from(`${disposition}${suffix}\r\n\r\n`), value });
  };
  try {
    signal.throwIfAborted();
    // Multipart has no null: an explicit null is omitted, as the legacy tools and query parameters do.
    for (const [field, value] of Object.entries(input.body ?? {})) {
      if (value === null) continue;
      const mode = op.request.fields![field];
      const values = mode === 'repeated' && Array.isArray(value) ? value : [value];
      for (const item of values) append(field, item !== null && typeof item === 'object' ? JSON.stringify(item) : String(item));
    }
    for (const [index, operand] of (input.files ?? []).entries()) {
      const binding = op.request.files!.find(file => file.field === operand.field)!;
      const paths = 'file_paths' in operand ? operand.file_paths : operand.file_path === null ? null : [operand.file_path];
      if (paths === null) continue;
      for (const [item, filePath] of paths.entries()) {
        const location = 'file_paths' in operand ? ['files', index, 'file_paths', item] : ['files', index, 'file_path'];
        let upload: Upload;
        try { upload = await openSandboxedUpload(filePath, context, location, binding.kind, binding); }
        catch (error) {
          if (error instanceof ElevenLabsError) throw new ApiBoundaryError(error.code, wrapUntrusted('The local file operand [REDACTED] could not be read safely. File operands must be local paths.', `elevenlabs:api:${op.operation_id}`)!, 'Provide an authorized regular file matching the declared type and size.');
          throw new ApiBoundaryError('FILE_READ_ERROR', 'The local upload could not be opened.', 'Check the file and host authorization.');
        }
        uploads.push(upload); append(operand.field, upload, binding.kind);
      }
    }
    const ending = Buffer.from(`--${boundary}--\r\n`);
    const length = parts.reduce((size, part) => size + part.header.length + (typeof part.value === 'string' ? Buffer.byteLength(part.value) : part.value.size) + 2, ending.length);
    stream = Readable.from((async function* () {
      for (const part of parts) {
        signal.throwIfAborted(); yield part.header;
        if (typeof part.value === 'string') yield Buffer.from(part.value);
        else yield* part.value.chunks(signal);
        yield Buffer.from('\r\n');
      }
      signal.throwIfAborted(); yield ending;
    })());
    signal.addEventListener('abort', abort, { once: true });
    return { body: Readable.toWeb(stream) as ReadableStream<Uint8Array>, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(length) }, close() {
      signal.removeEventListener('abort', abort); return close();
    } };
  } catch (error) { await close(); throw error; }
}
