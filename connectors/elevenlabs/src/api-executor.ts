import { createRedactor, sensitiveValues, type Redactor } from './api-sensitive.js';
import { getApiKey } from './auth.js';
import { ApiBoundaryError, getOperation, isBinaryResponseMedia, isRecord, loadApiCatalog, operationReference, type ApiOperation, type ApiProfile } from './api-catalog.js';
import { z } from 'zod';
import { base64Schema } from './api-schemas.js';
import type { RetainedOutput } from './api-streaming.js';
import { createSuccessReceipt, jsonArtifactSchema, loadApiValidator, validateRequest } from './api-validation.js';
import { elevenLabsFetch } from './client.js';
import { base64Representation, binaryRepresentation } from './api-media.mjs';
import { unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { writeWorkspaceArtifactStream } from './tools/path-safety.js';
import { ElevenLabsError, LONG_REQUEST_TIMEOUT_MS, REQUEST_TIMEOUT_MS, getErrorResolution } from './types.js';
import { unwrapUntrusted, wrapUntrusted } from './untrusted-content.js';
import type { FileReadContext } from './file-read-context.js';
import { multipartUpload } from './api-multipart.js';
import { artifactProgress, type ProgressContext } from './api-streaming.js';

/** Values only: provider map keys and schema properties are caller-owned data. */
function unwrapValues(value: unknown): unknown {
  if (typeof value === 'string') return unwrapUntrusted(value);
  if (Array.isArray(value)) return value.map(unwrapValues);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unwrapValues(item)]));
  return value;
}

function normalizedInput(input: unknown): unknown {
  if (!isRecord(input)) return input;
  return Object.fromEntries(Object.entries(input).map(([key, value]) =>
    [key, ['path_params', 'query_params', 'body'].includes(key) ? unwrapValues(value) : value]));
}

async function checkBeforeRetry(op: ApiOperation): Promise<string> {
  if (typeof op.check_before_retry !== 'string') return `No verifiable lookup: ${op.check_before_retry.unavailable_reason} Do not blindly retry; a repeated request may create another result or consume more credits.`;
  if (op.profile === 'create' && op.credential_return_fields) return 'No credential was confirmed. Request a new one if it is still needed.';
  const reads: string[] = [];
  let callable = false;
  for (const id of op.follow_ups) {
    const read = await getOperation(id);
    if (read.profile !== 'read') continue;
    reads.push(operationReference(read, op));
    if ([...read.path.matchAll(/\{([^{}]+)\}/g)].every(([, name]) => op.path.includes(`{${name}}`))) callable = true;
  }
  if (!callable) {
    reads.length = 0;
    const sameResource = (await loadApiCatalog()).operations.find(candidate => candidate.profile === 'read' && candidate.path === op.path);
    reads.push(operationReference(await getOperation(sameResource?.operation_id ?? op.check_before_retry, 'read'), op));
  }
  return `Check the result with ${reads.join(' or ')} through elevenlabs_read_resource before retrying. Use known IDs, or list first to find missing IDs.`;
}

async function timeoutFailure(op: ApiOperation, cancelled = false): Promise<ApiBoundaryError> {
  const interruption = cancelled ? 'was cancelled' : 'timed out';
  return new ApiBoundaryError(cancelled ? 'CANCELLED' : 'TIMEOUT', op.effects.readOnlyHint
    ? `The ElevenLabs request ${interruption}.`
    : `The ElevenLabs request ${interruption} after dispatch; the operation may have completed.`,
  `${await checkBeforeRetry(op)} ${cancelled ? 'Cancellation' : 'A timeout'} does not undo provider effects. No automatic retry was made.`);
}

async function responseFailure(op: ApiOperation, message: string): Promise<ApiBoundaryError> {
  return new ApiBoundaryError('INVALID_RESPONSE', message,
    `A 2xx request may have completed even though its response is invalid. ${await checkBeforeRetry(op)} Report the operation_id, status and media type to the connector maintainer; keep raw response content private.`);
}

async function fetchFailure(error: unknown, op: ApiOperation, signal: AbortSignal, redactor: Redactor): Promise<ElevenLabsError> {
  if (signal.aborted || (error instanceof Error && error.name === 'TimeoutError') || (error instanceof ElevenLabsError && error.code === 'TIMEOUT')) return timeoutFailure(op, signal.aborted && signal.reason?.name !== 'TimeoutError');
  if (!(error instanceof ElevenLabsError) || error.code === 'NETWORK_ERROR') return new ApiBoundaryError('NETWORK_ERROR', 'The request to ElevenLabs failed.',
    `The operation may have completed after dispatch. ${await checkBeforeRetry(op)} Check connectivity and provider availability. No automatic retry was made.`);

  if (op.credential_return_fields) return new ApiBoundaryError(error.code, redactor.wrap(`The provider rejected the request (${error.code}).`, `elevenlabs:api:${op.operation_id}`),
    `Inspect the operation contract and account permissions. ${await checkBeforeRetry(op)} No automatic retry was made.`);

  let resolution = error.resolution;
  if (error.code === 'HTTP_422') resolution = 'The provider rejected the request parameters. Correct the reported loc: msg field issues; inspect this operation with elevenlabs_discover_api. Do not repeat the unchanged request.';
  else if (error.code === 'HTTP_404') resolution = 'The resource was not found. Use elevenlabs_read_resource to list accessible resources and verify the ID and account before retrying.';
  else if (/^HTTP_3\d\d$/.test(error.code)) resolution = 'The provider returned a redirect. It was not followed. Report the operation_id and status to the connector maintainer; do not send the API key to the redirect target.';
  else if (/^HTTP_5\d\d$/.test(error.code)) resolution = `The provider reported a server error. ${await checkBeforeRetry(op)} Check provider availability. No automatic retry was made.`;
  else if (error.code === 'RATE_LIMITED') resolution = getErrorResolution(429);
  // Redact provider error text before constructing this boundary envelope.
  return new ApiBoundaryError(error.code, redactor.wrap(error.message, `elevenlabs:api:${op.operation_id}`), resolution);
}

/** Replace only declared audio operands; keep metadata beside each file, including preview identity. */
async function materializeAudio(data: unknown, descriptor: ApiOperation['responses'][number], outputFormat: unknown, signal: AbortSignal, saved: RetainedOutput[]) {
  const binding = descriptor.base64_audio!;
  const root = z.custom<Record<string, unknown>>(isRecord).parse(data);
  const items = binding.array ? z.array(z.custom<Record<string, unknown>>(isRecord)).parse(root[binding.array]) : [root];
  const converted = [];
  for (const [index, item] of items.entries()) {
    const audio = base64Schema.refine(value => Buffer.from(value, 'base64').toString('base64') === value).parse(item[binding.field]);
    const representation = base64Representation(descriptor, item, outputFormat);
    if (!representation) throw new Error('Undeclared audio media type.');
    const bytes = Buffer.from(audio, 'base64');
    const artifact = { ...await writeWorkspaceArtifactStream(`elevenlabs_${randomUUID()}.${representation.extension}`,
      new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }), signal),
      media_type: representation.media_type, source_path: binding.array ? [binding.array, index, binding.field] : [binding.field],
      ...('format' in representation ? { format: representation.format } : {}) };
    saved.push({ ...artifact, state: 'complete' });
    converted.push(Object.fromEntries([...Object.entries(item).filter(([key]) => key !== binding.field), ['artifact', jsonArtifactSchema.parse(artifact)]]));
  }
  return binding.array ? { ...root, [binding.array]: converted } : converted[0];
}

/** Shared production path for all eight profiles; file context is resolved only after validation. */
export async function executeApiOperation(profile: ApiProfile, rawInput: unknown, readContext?: () => FileReadContext, cancellationSignal?: AbortSignal, progressContext?: ProgressContext) {
  const normalized = normalizedInput(rawInput);
  // Resolve policy before validation, without authentication or network access.
  const op = isRecord(normalized) && typeof normalized.operation_id === 'string'
    ? await getOperation(normalized.operation_id) : undefined;
  const redactor = createRedactor([
    ...sensitiveValues(isRecord(rawInput) ? rawInput.body : undefined, op?.sensitive_request_fields ?? []),
    ...sensitiveValues(isRecord(normalized) ? normalized.body : undefined, op?.sensitive_request_fields ?? []),
  ]);
  return executeValidated(profile, normalized, redactor, readContext, cancellationSignal, progressContext);
}

async function executeValidated(profile: ApiProfile, rawInput: unknown, redactor: Redactor, readContext?: () => FileReadContext, cancellationSignal?: AbortSignal, progressContext?: ProgressContext) {
  const input = await validateRequest(profile, rawInput, redactor);
  const op = await getOperation(input.operation_id, profile);
  let path: string;
  let body: string | ReadableStream<Uint8Array> | undefined;
  try {
    path = op.path.replace(/\{([^{}]+)\}/g, (_placeholder, name: string) => encodeURIComponent(input.path_params![name]));
    body = op.request.media_type === 'multipart/form-data' || input.body === undefined ? undefined : JSON.stringify(input.body);
  } catch {
    throw new ApiBoundaryError('VALIDATION_ERROR', 'The arguments cannot be serialized for this operation.', 'Use JSON-compatible values and valid Unicode path operands.');
  }
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(input.query_params ?? {})) {
    if (value === null) continue;
    for (const item of Array.isArray(value) ? value : [value]) query.append(name, String(item));
  }
  const suffix = query.toString();
  const deadline = AbortSignal.timeout(op.timeout === 'long' ? LONG_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
  const signal = cancellationSignal ? AbortSignal.any([deadline, cancellationSignal]) : deadline;
  let upload: Awaited<ReturnType<typeof multipartUpload>> | undefined;
  if (op.request.media_type === 'multipart/form-data') {
    let reads: FileReadContext | undefined;
    try { reads = readContext?.(); } catch {
      throw new ApiBoundaryError('FILE_AUTHORIZATION_ERROR', 'Valid request file authorization is required for local file operands.',
        'Ask the host to authorize each exact files[index].file_path or files[index].file_paths[index] operand.');
    }
    upload = await multipartUpload(op, input, reads, signal);
    body = upload.body;
  }
  let response: Response;
  try {
    const key = getApiKey();
    redactor.include(key);
    response = await elevenLabsFetch(key, `https://api.elevenlabs.io${path}${suffix ? `?${suffix}` : ''}`, {
      method: op.method, redirect: 'manual', signal, ...(body === undefined ? {} : { body }),
      redactor,
      ...(upload ? { headers: upload.headers, duplex: 'half' as const } : {}),
      ...(typeof body === 'string' ? { headers: { 'Content-Type': op.request.media_type! } } : {}),
    }, op.operation_id);
  } catch (error) {
    throw await fetchFailure(error, op, signal, redactor);
  } finally { await upload?.close(); }

  const declared = op.responses.filter(candidate => candidate.status === response.status);
  // An explicitly empty status has no payload to parse, regardless of incidental headers.
  const empty = declared.find(candidate => candidate.media_type === null);
  const media = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? null;
  const outputFormat = input.query_params?.output_format;
  const descriptor = empty ?? declared.find(candidate => candidate.media_type === media || binaryRepresentation(candidate, media, outputFormat));
  if (!descriptor) throw await responseFailure(op, 'The provider returned an undeclared success status or media type.');
  let data: unknown = null, fileData: unknown;
  const saved: RetainedOutput[] = [];
  const representation = descriptor.media_type === null ? undefined : binaryRepresentation(descriptor, media, outputFormat);
  const progress = artifactProgress(representation?.media_type ?? media ?? 'application/octet-stream', progressContext, signal);
  if (descriptor.media_type !== null) {
    try {
      if (representation) {
        if (!response.body) throw new Error('Missing binary body.');
        data = { ...await writeWorkspaceArtifactStream(`elevenlabs_${randomUUID()}.${representation.extension}`, response.body, signal, progress),
          media_type: representation.media_type, ...('format' in representation ? { format: representation.format } : {}) };
      }
      else if (isBinaryResponseMedia(descriptor.media_type) || descriptor.media_type === 'audio/*') throw new Error('Invalid binary representation.');
      else data = descriptor.media_type === 'application/json' ? await response.json() : await response.text();
      if (descriptor.base64_audio) {
        (await loadApiValidator()).validateResponse(op, response.status, descriptor.media_type, data, redactor);
        fileData = await materializeAudio(data, descriptor, outputFormat, signal, saved);
      }
    } catch (error) {
      const retained_output = error instanceof ElevenLabsError ? error.retained_output ?? progress.retained() : progress.retained();
      const failure = signal.aborted || (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))
        ? await timeoutFailure(op, signal.aborted && signal.reason?.name !== 'TimeoutError')
        : await responseFailure(op, retained_output ? 'The output could not be completed. The partial output file was kept.' : error instanceof ElevenLabsError && error.code === 'PROGRESS_DELIVERY_FAILED' ? error.message : 'The provider response could not be read in its declared format.');
      if (saved.length) throw Object.assign(failure, { retained_outputs: saved, message: `${failure.message} Saved output files were kept.` });
      if (retained_output) throw Object.assign(failure, { retained_output, message: `${failure.message}${signal.aborted ? ' The partial output file was kept.' : ''}` });
      if (error instanceof ElevenLabsError && error.code.startsWith('OUTPUT_')) throw error;
      throw failure;
    }
  }
  try {
    const receipt = await createSuccessReceipt(op.operation_id, response.status, representation?.media_type ?? descriptor.media_type, data, redactor, outputFormat, fileData);
    if (progressContext) signal.throwIfAborted();
    await progress.finish('complete');
    return receipt;
  } catch (error) {
    let kept = false;
    let deliveryFailed = false;
    await progress.finish('incomplete').catch(() => { deliveryFailed = true; });
    if (!progress.retained() && representation && isRecord(data) && typeof data.file_path === 'string') await unlink(data.file_path).catch(() => { kept = true; });
    let message = error instanceof ElevenLabsError && error.code === 'PROGRESS_DELIVERY_FAILED' ? error.message : 'The provider returned success, but the connector could not safely process its response.';
    try {
      if (error instanceof ApiBoundaryError && error.code === 'INVALID_RESPONSE') message = redactor.wrap(error.message, `elevenlabs:api:${op.operation_id}`);
    } catch { /* Keep the safe post-dispatch guidance when redaction itself failed. */ }
    if (kept) message += ' The saved output file could not be removed.';
    if (deliveryFailed) message += ' Output progress could not be delivered.';
    const failure = signal.aborted ? await timeoutFailure(op, signal.reason?.name !== 'TimeoutError') : await responseFailure(op, message);
    if (progress.retained()) failure.message += ' The partial output file was kept.';
    if (saved.length) failure.message += ' Saved output files were kept.';
    throw Object.assign(failure, { retained_output: progress.retained(), ...(saved.length ? { retained_outputs: saved } : {}) });
  }
}
