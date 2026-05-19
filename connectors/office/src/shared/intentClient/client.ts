import {
  createRequestId,
  requestIdHeader,
  type DiagnosticSink,
  type IntentOp,
  type StreamCloseReason,
} from './diagnostics.js';
import { mapErrorResponse, mapFetchException, type ChatErrorCode } from './errors.js';
import type { IntentTransportAdapter } from './intentTransportAdapter.js';
import { safeEmit, safeInvoke } from './safeEmit.js';
import { parseSSEChunk, toStreamEvent } from './sse.js';
import type {
  ConnectStreamHandlers,
  CreateConversationInput,
  CreateConversationResult,
  FocusInRebelInput,
  FocusInRebelResult,
  GetHistoryInput,
  GetHistoryResult,
  IntentClientError,
  ResponseError,
  SendMessageInput,
  SendMessageResult,
} from './clientTypes.js';

const JSON_MEDIA_TYPE = 'application/json';

const INTENT_ROUTES = {
  createConversation: '/intent/conversation/create',
  sendMessage: '/intent/conversation/message',
  getHistory: '/intent/conversation/history',
  focusInRebel: '/intent/conversation/focus',
  connectStream: '/intent/conversation/stream',
} as const;

interface BuildHeadersResult {
  headers: Headers;
  tokenLen: number;
}

interface SignalComposition {
  signal: AbortSignal;
  cleanup: () => void;
}

export interface IntentClient {
  createConversation(
    input: CreateConversationInput,
    signal?: AbortSignal,
  ): Promise<CreateConversationResult>;
  sendMessage(
    input: SendMessageInput,
    signal?: AbortSignal,
  ): Promise<SendMessageResult>;
  getHistory(input: GetHistoryInput, signal?: AbortSignal): Promise<GetHistoryResult>;
  focusInRebel(
    input: FocusInRebelInput,
    signal?: AbortSignal,
  ): Promise<FocusInRebelResult>;
  connectStream(
    input: { conversationId: string; lastEventId?: string; signal?: AbortSignal },
    handlers: ConnectStreamHandlers,
  ): { close(): void };
}

export function createIntentClient(opts: {
  transport: IntentTransportAdapter;
  diagnostics?: DiagnosticSink;
  fetchImpl?: typeof fetch;
  defaultAbortSignal?: AbortSignal;
}): IntentClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const diagnostics = opts.diagnostics;
  const defaultAbortSignal = opts.defaultAbortSignal;
  const transport = opts.transport;

  async function buildHeaders(requestId: string): Promise<BuildHeadersResult> {
    const headers = await transport.buildHeaders({
      requestId,
      contentType: JSON_MEDIA_TYPE,
      accept: JSON_MEDIA_TYPE,
    });
    const [headerName, headerValue] = requestIdHeader(requestId);
    headers.set(headerName, headerValue);
    return {
      headers,
      tokenLen: getBearerTokenLength(headers),
    };
  }

  async function executeJsonOperation<TResult>(params: {
    op: Exclude<IntentOp, 'connectStream'>;
    route: string;
    body: Record<string, unknown>;
    signal?: AbortSignal;
    parse: (payload: unknown) => TResult;
  }): Promise<TResult> {
    const requestId = createRequestId();
    const url = resolveIntentUrl(transport.resolveBaseUrl(), params.route);
    const startedAt = Date.now();
    const internalAbort = new AbortController();
    const composedSignal = composeAbortSignals([
      internalAbort.signal,
      defaultAbortSignal,
      params.signal,
    ]);
    const stampedBody = transport.stampRequestBody?.(params.body) ?? params.body;
    const { headers, tokenLen } = await buildHeaders(requestId);

    safeEmit(diagnostics, {
      kind: 'fetch.start',
      op: params.op,
      url,
      requestId,
      tokenLen,
      ts: startedAt,
    });

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(stampedBody),
        signal: composedSignal.signal,
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch (err) {
      const mapped = mapFetchException(err, params.op);
      safeEmit(diagnostics, {
        kind: 'fetch.threw',
        op: params.op,
        url,
        requestId,
        durMs: Date.now() - startedAt,
        ts: Date.now(),
        shape: mapped.shape,
      });
      composedSignal.cleanup();
      throw toFetchError(mapped.code, mapped.shape, err);
    }

    safeEmit(diagnostics, {
      kind: 'fetch.response',
      op: params.op,
      url,
      requestId,
      status: response.status,
      ok: response.ok,
      durMs: Date.now() - startedAt,
      ts: Date.now(),
    });

    composedSignal.cleanup();

    if (!response.ok) {
      const bodyText = await safeReadText(response);
      const mapped = mapErrorResponse(response.status, bodyText);
      throw createClientError({
        code: mapped.code,
        message: mapped.message,
        status: response.status,
      });
    }

    const payload = await response.json().catch(() => null);
    return params.parse(payload);
  }

  function optionalSignal(signal: AbortSignal | undefined): { signal?: AbortSignal } {
    return signal ? { signal } : {};
  }

  async function createConversation(
    input: CreateConversationInput,
    signal?: AbortSignal,
  ): Promise<CreateConversationResult> {
    const parsed = await executeJsonOperation({
      op: 'createConversation',
      route: INTENT_ROUTES.createConversation,
      body: { ...input },
      ...optionalSignal(signal),
      parse: parseCreateConversationResult,
    });
    return parsed;
  }

  async function sendMessage(
    input: SendMessageInput,
    signal?: AbortSignal,
  ): Promise<SendMessageResult> {
    const parsed = await executeJsonOperation({
      op: 'sendMessage',
      route: INTENT_ROUTES.sendMessage,
      body: { ...input },
      ...optionalSignal(signal),
      parse: (payload) => parseSendMessageResult(payload, input.conversationId),
    });
    return parsed;
  }

  async function getHistory(
    input: GetHistoryInput,
    signal?: AbortSignal,
  ): Promise<GetHistoryResult> {
    const parsed = await executeJsonOperation({
      op: 'getHistory',
      route: INTENT_ROUTES.getHistory,
      body: { ...input },
      ...optionalSignal(signal),
      parse: (payload) => parseGetHistoryResult(payload, input.conversationId),
    });
    return parsed;
  }

  async function focusInRebel(
    input: FocusInRebelInput,
    signal?: AbortSignal,
  ): Promise<FocusInRebelResult> {
    const parsed = await executeJsonOperation({
      op: 'focusInRebel',
      route: INTENT_ROUTES.focusInRebel,
      body: { ...input },
      ...optionalSignal(signal),
      parse: (payload) => parseFocusInRebelResult(payload, input.conversationId),
    });
    return parsed;
  }

  function connectStream(
    input: { conversationId: string; lastEventId?: string; signal?: AbortSignal },
    handlers: ConnectStreamHandlers,
  ): { close(): void } {
    const requestId = createRequestId();
    const op: IntentOp = 'connectStream';
    const url = resolveIntentUrl(transport.resolveBaseUrl(), INTENT_ROUTES.connectStream);
    const startedAt = Date.now();
    const internalAbort = new AbortController();
    const composedSignal = composeAbortSignals([
      internalAbort.signal,
      defaultAbortSignal,
      input.signal,
    ]);
    let closed = false;

    const closeWithReason = (reason: StreamCloseReason): void => {
      if (closed) return;
      closed = true;
      safeInvoke(handlers.onClose, reason);
      safeEmit(diagnostics, {
        kind: 'stream.close',
        requestId,
        reason,
        durMs: Date.now() - startedAt,
        ts: Date.now(),
      });
    };

    const close = (): void => {
      if (internalAbort.signal.aborted) return;
      try {
        internalAbort.abort();
      } catch {
        // AbortController abort is idempotent.
      }
    };

    composedSignal.signal.addEventListener(
      'abort',
      () => {
        closeWithReason('aborted');
      },
      { once: true },
    );

    const run = async (): Promise<void> => {
      if (composedSignal.signal.aborted) {
        closeWithReason('aborted');
        composedSignal.cleanup();
        return;
      }

      const streamBody: Record<string, unknown> = {
        conversationId: input.conversationId,
      };
      if (typeof input.lastEventId === 'string' && input.lastEventId.length > 0) {
        streamBody.lastEventId = input.lastEventId;
      }
      const stampedBody = transport.stampRequestBody?.(streamBody) ?? streamBody;
      const { headers, tokenLen } = await buildHeaders(requestId);

      safeEmit(diagnostics, {
        kind: 'fetch.start',
        op,
        url,
        requestId,
        tokenLen,
        ts: startedAt,
      });

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(stampedBody),
          signal: composedSignal.signal,
          credentials: 'omit',
          cache: 'no-store',
        });
      } catch (err) {
        const mapped = mapFetchException(err, op);
        safeEmit(diagnostics, {
          kind: 'fetch.threw',
          op,
          url,
          requestId,
          durMs: Date.now() - startedAt,
          ts: Date.now(),
          shape: mapped.shape,
        });
        if (mapped.shape.isAbortError || composedSignal.signal.aborted) {
          closeWithReason('aborted');
        } else {
          safeInvoke(handlers.onError, mapped.shape);
          safeEmit(diagnostics, {
            kind: 'stream.err',
            requestId,
            durMs: Date.now() - startedAt,
            ts: Date.now(),
            shape: mapped.shape,
          });
          closeWithReason('error');
        }
        composedSignal.cleanup();
        return;
      }

      safeEmit(diagnostics, {
        kind: 'fetch.response',
        op,
        url,
        requestId,
        status: response.status,
        ok: response.ok,
        durMs: Date.now() - startedAt,
        ts: Date.now(),
      });

      if (!response.ok) {
        const bodyText = await safeReadText(response);
        const mapped = mapErrorResponse(response.status, bodyText);
        safeInvoke(handlers.onError, {
          code: mapped.code,
          message: mapped.message,
          status: response.status,
        });
        closeWithReason('error');
        composedSignal.cleanup();
        return;
      }

      if (!response.body) {
        const mapped = mapFetchException(
          new TypeError('SSE response body missing.'),
          'connectStream',
        );
        safeInvoke(handlers.onError, mapped.shape);
        safeEmit(diagnostics, {
          kind: 'stream.err',
          requestId,
          durMs: Date.now() - startedAt,
          ts: Date.now(),
          shape: mapped.shape,
        });
        closeWithReason('error');
        composedSignal.cleanup();
        return;
      }

      safeEmit(diagnostics, {
        kind: 'stream.open',
        requestId,
        conversationId: input.conversationId,
        ...(input.lastEventId ? { lastEventId: input.lastEventId } : {}),
        ts: Date.now(),
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (!closed) {
          const { done, value } = await reader.read();
          if (done) break;
          if (composedSignal.signal.aborted) {
            closeWithReason('aborted');
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          const parsed = parseSSEChunk(buffer);
          buffer = parsed.remainder;
          for (const frame of parsed.events) {
            const event = toStreamEvent(frame);
            if (!event) continue;
            safeEmit(diagnostics, {
              kind: 'stream.event',
              requestId,
              eventKind: event.type,
              ts: Date.now(),
            });
            safeInvoke(handlers.onEvent, event);
            if (event.type === 'revoked') {
              closeWithReason('revoked');
              return;
            }
          }
        }

        if (closed) return;
        buffer += decoder.decode();
        const tail = parseSSEChunk(`${buffer}\n\n`);
        for (const frame of tail.events) {
          const event = toStreamEvent(frame);
          if (!event) continue;
          safeEmit(diagnostics, {
            kind: 'stream.event',
            requestId,
            eventKind: event.type,
            ts: Date.now(),
          });
          safeInvoke(handlers.onEvent, event);
          if (event.type === 'revoked') {
            closeWithReason('revoked');
            return;
          }
        }

        if (!closed) {
          closeWithReason(composedSignal.signal.aborted ? 'aborted' : 'eof');
        }
      } catch (err) {
        if (closed) return;
        const mapped = mapFetchException(err, 'connectStream');
        if (mapped.shape.isAbortError || composedSignal.signal.aborted) {
          closeWithReason('aborted');
          return;
        }
        safeInvoke(handlers.onError, mapped.shape);
        safeEmit(diagnostics, {
          kind: 'stream.err',
          requestId,
          durMs: Date.now() - startedAt,
          ts: Date.now(),
          shape: mapped.shape,
        });
        closeWithReason('error');
      } finally {
        composedSignal.cleanup();
      }
    };

    void run();
    return { close };
  }

  return {
    createConversation,
    sendMessage,
    getHistory,
    focusInRebel,
    connectStream,
  };
}

function resolveIntentUrl(baseUrl: string, path: string): string {
  if (baseUrl.endsWith('/') && path.startsWith('/')) {
    return `${baseUrl.slice(0, -1)}${path}`;
  }
  return `${baseUrl}${path}`;
}

function getBearerTokenLength(headers: Headers): number {
  const authHeader = headers.get('authorization');
  if (!authHeader) return 0;
  const match = /^Bearer\s+/i.exec(authHeader);
  if (!match) return authHeader.length;
  return authHeader.slice(match[0].length).length;
}

function composeAbortSignals(signals: Array<AbortSignal | undefined>): SignalComposition {
  const filtered = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (filtered.length === 0) {
    const controller = new AbortController();
    return { signal: controller.signal, cleanup: () => undefined };
  }
  if (filtered.length === 1) {
    return { signal: filtered[0]!, cleanup: () => undefined };
  }

  const anyFn = (
    AbortSignal as typeof AbortSignal & {
      any?: (signals: AbortSignal[]) => AbortSignal;
    }
  ).any;
  if (typeof anyFn === 'function') {
    return {
      signal: anyFn.call(AbortSignal, filtered),
      cleanup: () => undefined,
    };
  }

  const fallback = new AbortController();
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
  const abort = (): void => {
    if (!fallback.signal.aborted) {
      fallback.abort();
    }
  };

  for (const signal of filtered) {
    if (signal.aborted) {
      abort();
      break;
    }
    const listener = (): void => abort();
    signal.addEventListener('abort', listener, { once: true });
    listeners.push({ signal, listener });
  }

  const cleanup = (): void => {
    for (const { signal, listener } of listeners) {
      signal.removeEventListener('abort', listener);
    }
  };

  return { signal: fallback.signal, cleanup };
}

function toFetchError(
  code: ChatErrorCode,
  shape: { isAbortError: boolean },
  original: unknown,
): IntentClientError {
  if (shape.isAbortError) {
    const message =
      original instanceof Error && original.message.length > 0
        ? original.message
        : 'The operation was aborted.';
    return createClientError({
      code: 'ABORTED',
      message,
      name: 'AbortError',
    });
  }
  if (code === 'TIMEOUT') {
    return createClientError({
      code,
      message: 'Rebel took too long to respond. Try again.',
    });
  }
  return createClientError({
    code,
    message: "Couldn't reach Rebel right now.",
  });
}

function createClientError(input: {
  code: ChatErrorCode;
  message: string;
  status?: number;
  name?: string;
}): IntentClientError {
  const error = new Error(input.message) as IntentClientError;
  error.name = input.name ?? 'IntentClientError';
  error.code = input.code;
  if (typeof input.status === 'number') {
    error.status = input.status;
  }
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseCreateConversationResult(payload: unknown): CreateConversationResult {
  if (!isRecord(payload) || typeof payload.conversationId !== 'string') {
    throw createClientError({
      code: 'UNKNOWN',
      message: 'Rebel replied without a conversation id.',
    });
  }
  const result: CreateConversationResult = {
    conversationId: payload.conversationId,
  };
  if (payload.state === 'new' || payload.state === 'resumed') {
    result.state = payload.state;
  }
  return result;
}

function parseSendMessageResult(
  payload: unknown,
  conversationId: string,
): SendMessageResult {
  if (
    !isRecord(payload) ||
    typeof payload.messageId !== 'string' ||
    (payload.state !== 'submitted' && payload.state !== 'buffered') ||
    typeof payload.queueSize !== 'number'
  ) {
    throw createClientError({
      code: 'UNKNOWN',
      message: 'Rebel replied without a valid message receipt.',
    });
  }
  return {
    conversationId:
      typeof payload.conversationId === 'string' ? payload.conversationId : conversationId,
    messageId: payload.messageId,
    state: payload.state,
    queueSize: payload.queueSize,
  };
}

function parseGetHistoryResult(payload: unknown, conversationId: string): GetHistoryResult {
  if (!isRecord(payload) || !Array.isArray(payload.messages)) {
    throw createClientError({
      code: 'UNKNOWN',
      message: 'Rebel replied without a valid message list.',
    });
  }
  if (payload.turnStatus !== 'idle' && payload.turnStatus !== 'running') {
    throw createClientError({
      code: 'UNKNOWN',
      message: 'Rebel replied with an unknown turn status.',
    });
  }

  const messages: GetHistoryResult['messages'] = [];
  for (const message of payload.messages) {
    if (!isRecord(message)) continue;
    if (
      typeof message.id !== 'string' ||
      (message.role !== 'user' && message.role !== 'assistant') ||
      typeof message.text !== 'string' ||
      typeof message.createdAt !== 'number'
    ) {
      continue;
    }
    messages.push({
      id: message.id,
      role: message.role,
      text: message.text,
      createdAt: message.createdAt,
      ...(typeof message.turnId === 'string' ? { turnId: message.turnId } : {}),
    });
  }

  return {
    conversationId:
      typeof payload.conversationId === 'string' ? payload.conversationId : conversationId,
    messages,
    turnStatus: payload.turnStatus,
    ...(typeof payload.conversationTitle === 'string' && payload.conversationTitle.length > 0
      ? { conversationTitle: payload.conversationTitle }
      : {}),
  };
}

function parseFocusInRebelResult(
  payload: unknown,
  conversationId: string,
): FocusInRebelResult {
  if (!isRecord(payload)) {
    throw createClientError({
      code: 'UNKNOWN',
      message: 'Rebel replied without a focus result.',
    });
  }
  return {
    conversationId:
      typeof payload.conversationId === 'string' ? payload.conversationId : conversationId,
    focused: typeof payload.focused === 'boolean' ? payload.focused : true,
  };
}

async function safeReadText(response: Response): Promise<string | null> {
  try {
    return await response.text();
  } catch {
    return null;
  }
}

export function isResponseError(value: unknown): value is ResponseError {
  if (!isRecord(value)) return false;
  return typeof value.code === 'string' && typeof value.message === 'string';
}
