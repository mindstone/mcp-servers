import { getApiKey } from './auth.js';
import { z } from 'zod';
import { ApiBoundaryError, getOperation, isRecord, loadApiCatalog, type ApiOperation, type ApiProfile } from './api-catalog.js';
import { createSuccessReceipt, validateRequest } from './api-validation.js';
import { elevenLabsFetch } from './client.js';
import { ElevenLabsError, LONG_REQUEST_TIMEOUT_MS, REQUEST_TIMEOUT_MS, getErrorResolution } from './types.js';
import { unwrapUntrusted, wrapUntrusted } from './untrusted-content.js';
import type { FileReadContext } from './file-read-context.js';
import { documentMimeTypeForFileName, readSandboxedFile } from './tools/file-input.js';

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
  const reads: string[] = [];
  let callable = false;
  for (const id of op.follow_ups) {
    const read = await getOperation(id);
    if (read.profile !== 'read') continue;
    reads.push(id);
    if ([...read.path.matchAll(/\{([^{}]+)\}/g)].every(([, name]) => op.path.includes(`{${name}}`))) callable = true;
  }
  if (!callable) {
    reads.length = 0;
    const sameResource = (await loadApiCatalog()).operations.find(candidate => candidate.profile === 'read' && candidate.path === op.path);
    const fallback = op.profile === 'tests' ? 'get_test_invocation_route'
      : op.family === 'tools' ? 'get_tools_route'
      : op.family === 'knowledge-base' ? 'get_knowledge_base_list_route'
      : op.family === 'agent-testing' ? 'list_chat_response_tests_route'
      : op.family === 'test-invocations' ? 'list_test_invocations_route' : 'get_agents_route';
    reads.push((await getOperation(sameResource?.operation_id ?? fallback, 'read')).operation_id);
  }
  return `Check the result with ${reads.join(' or ')} through elevenlabs_read_resource before retrying.${op.operation_id === 'run_agent_test_suite_route' ? ' If the run response was lost, list_test_invocations_route accepts the known agent_id in query_params; use an invocation ID from that result for get_test_invocation_route.' : ''}`;
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

function redact(text: string, key: string): string {
  if (!key) return text;
  return [...new Set([key, encodeURIComponent(key)])].reduce((result, secret) => result.split(secret).join('[REDACTED]'), text);
}

async function fetchFailure(error: unknown, op: ApiOperation, key: string, signal: AbortSignal): Promise<ElevenLabsError> {
  if (signal.aborted || (error instanceof Error && error.name === 'TimeoutError') || (error instanceof ElevenLabsError && error.code === 'TIMEOUT')) return timeoutFailure(op);
  if (!(error instanceof ElevenLabsError)) return new ApiBoundaryError('NETWORK_ERROR', 'The request to ElevenLabs failed.',
    `${await checkBeforeRetry(op)} Check connectivity and provider availability. No automatic retry was made.`);

  let resolution = error.resolution;
  if (error.code === 'HTTP_422') resolution = 'The provider rejected the request parameters. Correct the reported loc: msg field issues; inspect this operation with elevenlabs_discover_api. Do not repeat the unchanged request.';
  else if (error.code === 'HTTP_404') resolution = 'The resource was not found. Use elevenlabs_read_resource to list accessible resources and verify the ID and account before retrying.';
  else if (/^HTTP_3\d\d$/.test(error.code)) resolution = 'The provider returned a redirect. It was not followed. Report the operation_id and status to the connector maintainer; do not send the API key to the redirect target.';
  else if (/^HTTP_5\d\d$/.test(error.code)) resolution = `The provider reported a server error. ${await checkBeforeRetry(op)} Check provider availability. No automatic retry was made.`;
  else if (error.code === 'RATE_LIMITED') resolution = getErrorResolution(429);
  // The legacy client already extracts loc/msg without FastAPI's raw input field.
  // Re-enveloping also contains any provider-authored text in legacy diagnostics.
  return new ApiBoundaryError(error.code, wrapUntrusted(redact(error.message, key), `elevenlabs:api:${op.operation_id}`)!, redact(resolution, key));
}

/** Shared production path for all six profiles; file context is resolved only after validation. */
export async function executeApiOperation(profile: ApiProfile, rawInput: unknown, readContext?: () => FileReadContext) {
  const input = await validateRequest(profile, normalizedInput(rawInput));
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
      const file = readSandboxedFile(operand.file_path, reads, ['files', index, 'file_path'], 'document');
      form.append(operand.field, new Blob([new Uint8Array(file.buffer)], { type: documentMimeTypeForFileName(file.fileName) }), file.fileName);
    }
    body = form;
  }
  const key = getApiKey();
  const signal = AbortSignal.timeout(op.timeout === 'long' ? LONG_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await elevenLabsFetch(key, `https://api.elevenlabs.io${path}${suffix ? `?${suffix}` : ''}`, {
      method: op.method, redirect: 'manual', signal, ...(body === undefined ? {} : { body }),
      ...(typeof body === 'string' ? { headers: { 'Content-Type': op.request.media_type! } } : {}),
    }, op.operation_id);
  } catch (error) {
    throw await fetchFailure(error, op, key, signal);
  }

  const declared = op.responses.filter(candidate => candidate.status === response.status);
  // An explicitly empty status has no payload to parse, regardless of incidental headers.
  const empty = declared.find(candidate => candidate.media_type === null);
  const media = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? null;
  const descriptor = empty ?? declared.find(candidate => candidate.media_type === media);
  if (!descriptor) throw await responseFailure(op, 'The provider returned an undeclared success status or media type.');
  let data: unknown = null;
  if (descriptor.media_type !== null) {
    try {
      data = descriptor.media_type === 'application/json' ? await response.json() : await response.text();
    } catch (error) {
      if (signal.aborted || (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))) throw await timeoutFailure(op);
      throw await responseFailure(op, 'The provider response could not be read in its declared format.');
    }
  }
  try {
    return await createSuccessReceipt(op.operation_id, response.status, descriptor.media_type, data);
  } catch (error) {
    if (error instanceof ElevenLabsError && error.code === 'INVALID_RESPONSE') throw await responseFailure(op, 'The provider response has invalid fields required by the connector.');
    throw error;
  }
}
