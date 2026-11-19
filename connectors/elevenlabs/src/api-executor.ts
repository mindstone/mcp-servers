import { createRedactor, sensitiveValues, type Redactor } from './api-sensitive.js';
import { getApiKey } from './auth.js';
import { z } from 'zod';
import { ApiBoundaryError, getOperation, isBinaryResponseMedia, isRecord, loadApiCatalog, operationReference, type ApiOperation, type ApiProfile } from './api-catalog.js';
import { createSuccessReceipt, validateRequest } from './api-validation.js';
import { elevenLabsFetch, extensionFromContentType } from './client.js';
import { randomUUID } from 'node:crypto';
import { writeWorkspaceArtifact } from './tools/path-safety.js';
import { ElevenLabsError, LONG_REQUEST_TIMEOUT_MS, REQUEST_TIMEOUT_MS, getErrorResolution } from './types.js';
import { unwrapUntrusted, wrapUntrusted } from './untrusted-content.js';
import type { FileReadContext } from './file-read-context.js';
import { fileMimeTypeForFileName, readSandboxedFile } from './tools/file-input.js';

const multipartScalar = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);

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

async function timeoutFailure(op: ApiOperation): Promise<ApiBoundaryError> {
  return new ApiBoundaryError('TIMEOUT', op.effects.readOnlyHint
    ? 'The ElevenLabs request timed out.'
    : 'The ElevenLabs request timed out after dispatch; the operation may have completed.',
  `${await checkBeforeRetry(op)} A timeout does not undo provider effects. No automatic retry was made.`);
}

async function responseFailure(op: ApiOperation, message: string): Promise<ApiBoundaryError> {
  return new ApiBoundaryError('INVALID_RESPONSE', message,
    `A 2xx request may have completed even though its response is invalid. ${await checkBeforeRetry(op)} Report the operation_id, status and media type to the connector maintainer; keep raw response content private.`);
}

async function fetchFailure(error: unknown, op: ApiOperation, signal: AbortSignal, redactor: Redactor): Promise<ElevenLabsError> {
  if (signal.aborted || (error instanceof Error && error.name === 'TimeoutError') || (error instanceof ElevenLabsError && error.code === 'TIMEOUT')) return timeoutFailure(op);
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

/** Shared production path for all seven profiles; file context is resolved only after validation. */
export async function executeApiOperation(profile: ApiProfile, rawInput: unknown, readContext?: () => FileReadContext) {
  const normalized = normalizedInput(rawInput);
  // Resolve policy before validation, without authentication or network access.
  const op = isRecord(normalized) && typeof normalized.operation_id === 'string'
    ? await getOperation(normalized.operation_id) : undefined;
  const redactor = createRedactor([
    ...sensitiveValues(isRecord(rawInput) ? rawInput.body : undefined, op?.sensitive_request_fields ?? []),
    ...sensitiveValues(isRecord(normalized) ? normalized.body : undefined, op?.sensitive_request_fields ?? []),
  ]);
  return executeValidated(profile, normalized, redactor, readContext);
}

async function executeValidated(profile: ApiProfile, rawInput: unknown, redactor: Redactor, readContext?: () => FileReadContext) {
  const input = await validateRequest(profile, rawInput, redactor);
  const op = await getOperation(input.operation_id, profile);
  let path: string;
  let body: string | FormData | undefined;
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
  if (op.request.media_type === 'multipart/form-data') {
    const form = new FormData();
    for (const [name, value] of Object.entries(input.body ?? {})) {
      const scalar = multipartScalar.safeParse(value);
      if (!scalar.success) throw new ApiBoundaryError('VALIDATION_ERROR',
        'Multipart body fields must be scalar values.', 'Use the declared scalar fields from discovery; local document paths belong only in files.');
      if (scalar.data !== null) form.append(name, String(scalar.data));
    }
    let reads: FileReadContext | undefined;
    try { reads = readContext?.(); } catch {
      throw new ApiBoundaryError('FILE_AUTHORIZATION_ERROR', 'Valid request file authorization is required for document operands.',
        'Ask the host to authorize the exact files[index].file_path operand and supply valid files/readMode metadata.');
    }
    for (const [index, operand] of (input.files ?? []).entries()) {
      const binding = op.request.files!.find(file => file.field === operand.field)!;
      let file: ReturnType<typeof readSandboxedFile>;
      try {
        file = readSandboxedFile(operand.file_path, reads, ['files', index, 'file_path'], binding.kind, binding);
      } catch (error) {
        if (error instanceof ElevenLabsError) throw new ElevenLabsError(wrapUntrusted('The files.file_path operand [REDACTED] could not be read safely. File operands must be local paths. Check files.field and files.file_path against the declared file contract and host authorization.', `elevenlabs:api:${op.operation_id}`)!, error.code, 'Provide an authorized file matching the declared type and size.');
        throw error;
      }
      form.append(operand.field, new Blob([new Uint8Array(file.buffer)], { type: fileMimeTypeForFileName(file.fileName, binding.kind) }), file.fileName);
    }
    body = form;
  }
  const key = getApiKey();
  redactor.include(key);
  const signal = AbortSignal.timeout(op.timeout === 'long' ? LONG_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await elevenLabsFetch(key, `https://api.elevenlabs.io${path}${suffix ? `?${suffix}` : ''}`, {
      method: op.method, redirect: 'manual', signal, ...(body === undefined ? {} : { body }),
      redactor,
      ...(typeof body === 'string' ? { headers: { 'Content-Type': op.request.media_type! } } : {}),
    }, op.operation_id);
  } catch (error) {
    throw await fetchFailure(error, op, signal, redactor);
  }

  const declared = op.responses.filter(candidate => candidate.status === response.status);
  // An explicitly empty status has no payload to parse, regardless of incidental headers.
  const empty = declared.find(candidate => candidate.media_type === null);
  const media = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? null;
  const descriptor = empty ?? declared.find(candidate => candidate.media_type === media);
  if (!descriptor) throw await responseFailure(op, 'The provider returned an undeclared success status or media type.');
  let data: unknown = null;
  let binary: Buffer | undefined;
  if (descriptor.media_type !== null) {
    try {
      if (isBinaryResponseMedia(descriptor.media_type)) binary = Buffer.from(await response.arrayBuffer());
      else data = descriptor.media_type === 'application/json' ? await response.json() : await response.text();
    } catch (error) {
      if (signal.aborted || (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))) throw await timeoutFailure(op);
      throw await responseFailure(op, 'The provider response could not be read in its declared format.');
    }
  }
  if (binary !== undefined) {
    // Never use provider headers, filenames or IDs in a filesystem path or receipt metadata.
    const filePath = writeWorkspaceArtifact(`elevenlabs_${randomUUID()}.${extensionFromContentType(descriptor.media_type)}`, binary);
    data = { file_path: filePath, size_bytes: binary.length, media_type: descriptor.media_type };
  }
  try {
    return await createSuccessReceipt(op.operation_id, response.status, descriptor.media_type, data, redactor);
  } catch (error) {
    let message = 'The provider returned success, but the connector could not safely process its response.';
    try {
      if (error instanceof ApiBoundaryError && error.code === 'INVALID_RESPONSE') message = redactor.wrap(error.message, `elevenlabs:api:${op.operation_id}`);
    } catch { /* Keep the safe post-dispatch guidance when redaction itself failed. */ }
    throw await responseFailure(op, message);
  }
}
