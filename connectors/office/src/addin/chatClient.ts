/**
 * Office task pane chat client.
 *
 * Stage 4 migrates the Office surface onto `@rebel/shared`'s
 * `createIntentClient(...)` while preserving the public API consumed by
 * `chatUI.ts`.
 */

import {
  composeDiagnosticSinks,
  createInMemoryDiagnosticBuffer,
  createIntentClient,
  isResponseError,
  parseSSEChunk as parseSharedSSEChunk,
  type ChatErrorCode as SharedChatErrorCode,
  type ConnectStreamError,
  type ConnectStreamEvent,
  type DiagnosticEvent,
  type DiagnosticSink,
  type IntentClient,
  type IntentClientError,
  type IntentKind as SharedIntentKind,
  type IntentTransportAdapter,
  type StreamCloseReason,
} from '../shared/intentClient/index.js';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * Sidecar-proxy connection config — injected by the sidecar.
 *
 * `originBase` is test-only: production callers omit it and all
 * `/intent/*` fetches go to the task-pane's own origin (the sidecar).
 */
export interface SidecarChatConfig {
  /** Bearer token shared by the sidecar WebSocket + the HTTP proxy. */
  sidecarToken: string;
  /** Optional explicit origin for tests (e.g. https://127.0.0.1:port). */
  originBase?: string;
}

export interface TaskpaneDiagnosticApi {
  dump(): DiagnosticEvent[];
  dumpById(requestId: string): DiagnosticEvent[];
  clear(): void;
  tailId(): string | null;
}

export interface TaskpaneDiagnosticWindowLike {
  __rebelDiag?: TaskpaneDiagnosticApi;
}

/** Back-compat alias used by chatUI/taskpane wiring. */
export type BridgeConfig = SidecarChatConfig;

/** Intent kinds the bridge knows about. */
export type IntentKind = SharedIntentKind;

/** Minimal Office document context carried alongside embedded chat requests. */
export interface DocumentContext {
  host?: string;
  url?: string;
  title?: string;
}

/** Free-form context surfaced alongside the first message. */
export interface PageContext {
  title?: string;
  url?: string;
}

/**
 * Legacy Office chat error envelope. Keep this narrowed surface for
 * compatibility with the existing plain-DOM UI error handling.
 */
export type ChatErrorCode = Extract<
  SharedChatErrorCode,
  | 'NOT_IMPLEMENTED'
  | 'NOT_FOUND'
  | 'APP_NOT_CONNECTED'
  | 'PORT_UNREACHABLE'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'INTERNAL_ERROR'
  | 'UNKNOWN'
>;

// ---------------------------------------------------------------------------
// Messages + stream events
// ---------------------------------------------------------------------------

export interface HistoryMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: number;
  turnId?: string;
  partial?: boolean;
}

export type StreamEvent = ConnectStreamEvent;

// ---------------------------------------------------------------------------
// Inputs / results
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 5_000;
const DIAG_MAX_PAYLOAD_BYTES = 4_000;
const DIAG_REQUEST_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PORT_UNREACHABLE_COPY = "Couldn't find Rebel on this computer. Is the app open?";
const NETWORK_ERROR_COPY = "Couldn't reach the Rebel app on this computer.";
const TIMEOUT_COPY = 'Rebel took too long to respond. Try again.';
const NOT_IMPLEMENTED_COPY =
  "Rebel can't take this action yet — the feature is still landing. Please try again soon.";
const APP_NOT_CONNECTED_COPY = "Rebel isn't reachable right now. Try again in a moment.";
const UNAUTHORIZED_COPY =
  "Rebel's browser connection isn't paired yet. Open Rebel and finish setup to start chatting here.";
const NOT_FOUND_COPY = 'This conversation no longer exists in Rebel.';
const BAD_REQUEST_COPY = 'Rebel rejected the request.';
const UNKNOWN_COPY = 'Rebel returned an unexpected response.';

export interface CreateConversationInput extends BridgeConfig {
  intent: IntentKind;
  userText: string;
  documentContext?: DocumentContext;
  pageContext?: PageContext;
  title?: string;
  switchToConversation?: boolean;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type CreateConversationResult =
  | { ok: true; conversationId: string; state?: 'new' | 'resumed' }
  | { ok: false; error: ChatErrorCode; message: string; status?: number };

export interface SendMessageInput extends BridgeConfig {
  conversationId: string;
  text: string;
  documentContext?: DocumentContext;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type SendMessageResult =
  | {
      ok: true;
      messageId: string;
      state: 'submitted' | 'buffered';
      queueSize: number;
    }
  | { ok: false; error: ChatErrorCode; message: string; status?: number };

export interface GetHistoryInput extends BridgeConfig {
  conversationId: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type GetHistoryResult =
  | {
      ok: true;
      messages: HistoryMessage[];
      turnStatus: 'idle' | 'running';
      conversationTitle?: string;
    }
  | { ok: false; error: ChatErrorCode; message: string; status?: number };

export interface FocusInRebelInput extends BridgeConfig {
  conversationId: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type FocusInRebelResult =
  | { ok: true }
  | { ok: false; error: ChatErrorCode; message: string; status?: number };

export interface ConnectStreamInput extends BridgeConfig {
  conversationId: string;
  fetchImpl?: typeof fetch;
  onEvent: (event: StreamEvent) => void;
  onError?: (error: Error) => void;
  /**
   * Back-compat: existing callers pass `() => void`; Stage 4 now forwards
   * close reasons (`'eof' | 'revoked' | 'error' | 'aborted'`).
   */
  onClose?: (reason?: StreamCloseReason) => void;
  signal?: AbortSignal;
}

export interface StreamConnection {
  close(): void;
}

// ---------------------------------------------------------------------------
// Office transport adapter
// ---------------------------------------------------------------------------

interface TransportAuthHints {
  sidecarToken?: string;
  originBase?: string;
  conversationId?: string;
}

interface TokenMetadata {
  tokenLen: number;
  tokenPrefix: string;
}

interface OfficeTransportAdapter extends IntentTransportAdapter {
  setAuthHints(hints: TransportAuthHints): void;
  handleUnauthorizedResponse(): void;
  handleAuthRevoked(): void;
  isReachable(fetchImpl?: typeof fetch): Promise<boolean>;
  peekTokenMetadata(): TokenMetadata;
}

interface OfficeTransportAdapterOptions {
  fetchImpl?: typeof fetch;
}

class OfficeSidecarTransportAdapter implements OfficeTransportAdapter {
  private authHints: TransportAuthHints = {};
  private cachedMintedToken: string | null = null;
  private readonly defaultFetch: typeof fetch;

  constructor(options: OfficeTransportAdapterOptions = {}) {
    this.defaultFetch = options.fetchImpl ?? resolveFetchImpl();
  }

  setAuthHints(hints: TransportAuthHints): void {
    this.authHints = {
      ...(isNonEmptyString(hints.sidecarToken) ? { sidecarToken: hints.sidecarToken } : {}),
      ...(typeof hints.originBase === 'string' ? { originBase: hints.originBase } : {}),
      ...(isNonEmptyString(hints.conversationId)
        ? { conversationId: hints.conversationId }
        : {}),
    };
  }

  resolveBaseUrl(): string {
    return this.authHints.originBase ?? '';
  }

  async buildHeaders(init: {
    requestId: string;
    contentType?: string;
    accept?: string;
  }): Promise<Headers> {
    void init.requestId;
    const token = await this.ensureMintedToken();
    if (!token) {
      throw createIntentError({
        code: 'PORT_UNREACHABLE',
        message: PORT_UNREACHABLE_COPY,
      });
    }

    const headers = new Headers();
    headers.set('authorization', `Bearer ${token}`);
    if (isNonEmptyString(init.contentType)) {
      headers.set('content-type', init.contentType);
    }
    if (isNonEmptyString(init.accept)) {
      headers.set('accept', init.accept);
    }
    if (isNonEmptyString(this.authHints.conversationId)) {
      headers.set('x-rebel-conversation-id', this.authHints.conversationId);
    }
    return headers;
  }

  describeForLog(): {
    surface: 'office-addin';
    origin: string;
    transportKind: 'sidecar-proxy';
  } {
    return {
      surface: 'office-addin',
      origin: this.resolveBaseUrl(),
      transportKind: 'sidecar-proxy',
    };
  }

  async probeReachability(): Promise<boolean> {
    return this.isReachable();
  }

  async isReachable(fetchImpl?: typeof fetch): Promise<boolean> {
    const effectiveFetch = fetchImpl ?? this.defaultFetch;
    if (typeof effectiveFetch !== 'function') {
      return false;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    try {
      const url = resolveDiagPingUrl(this.resolveBaseUrl());
      const response = await effectiveFetch(url, {
        method: 'GET',
        signal: controller.signal,
        credentials: 'omit',
        cache: 'no-store',
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  handleUnauthorizedResponse(): void {
    this.cachedMintedToken = null;
  }

  handleAuthRevoked(): void {
    this.cachedMintedToken = null;
  }

  peekTokenMetadata(): TokenMetadata {
    return {
      tokenLen: this.cachedMintedToken?.length ?? 0,
      tokenPrefix: this.cachedMintedToken?.slice(0, 4) ?? '-',
    };
  }

  private async ensureMintedToken(): Promise<string | null> {
    if (this.cachedMintedToken) {
      return this.cachedMintedToken;
    }
    const minted = await this.mintToken();
    if (!minted) {
      this.cachedMintedToken = null;
      return null;
    }
    this.cachedMintedToken = minted;
    return minted;
  }

  private async mintToken(): Promise<string | null> {
    const fromWindow = readWindowSidecarToken();
    if (isNonEmptyString(fromWindow)) {
      return fromWindow;
    }
    return readString(this.authHints.sidecarToken);
  }
}

function createOfficeTransportAdapter(
  options: OfficeTransportAdapterOptions = {},
): OfficeTransportAdapter {
  return new OfficeSidecarTransportAdapter(options);
}

// ---------------------------------------------------------------------------
// Diagnostic sinks (buffer + sidecar)
// ---------------------------------------------------------------------------

interface SidecarDiagnosticSinkOptions {
  fetchImpl?: typeof fetch;
  tokenMetadataProvider?: () => TokenMetadata;
  onAuthRevoked?: () => void;
  maxPayloadBytes?: number;
}

class SidecarDiagnosticSink implements DiagnosticSink {
  private readonly fetchImpl: typeof fetch;
  private readonly tokenMetadataProvider: () => TokenMetadata;
  private readonly onAuthRevoked: (() => void) | undefined;
  private readonly maxPayloadBytes: number;

  constructor(options: SidecarDiagnosticSinkOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? resolveFetchImpl();
    this.tokenMetadataProvider =
      options.tokenMetadataProvider ??
      (() => ({
        tokenLen: 0,
        tokenPrefix: '-',
      }));
    this.onAuthRevoked = options.onAuthRevoked;
    this.maxPayloadBytes =
      Number.isFinite(options.maxPayloadBytes) && (options.maxPayloadBytes ?? 0) > 0
        ? Math.floor(options.maxPayloadBytes ?? DIAG_MAX_PAYLOAD_BYTES)
        : DIAG_MAX_PAYLOAD_BYTES;
  }

  emit(event: DiagnosticEvent): void {
    safeEmit(() => {
      this.forwardEvent(event);
    });
  }

  private forwardEvent(event: DiagnosticEvent): void {
    switch (event.kind) {
      case 'fetch.start': {
        const tokenMetadata = this.tokenMetadataProvider();
        emitTaskpaneDiag(
          'fetch.start',
          {
            op: event.op,
            url: event.url,
            requestId: event.requestId,
            hasToken: event.tokenLen > 0,
            tokenLen: event.tokenLen,
            tokenPrefix:
              tokenMetadata.tokenLen === event.tokenLen
                ? tokenMetadata.tokenPrefix
                : tokenMetadata.tokenLen > 0
                  ? tokenMetadata.tokenPrefix
                  : '-',
          },
          this.fetchImpl,
          this.maxPayloadBytes,
        );
        return;
      }
      case 'fetch.response': {
        const payload = {
          op: event.op,
          url: event.url,
          requestId: event.requestId,
          status: event.status,
          ok: event.ok,
          durMs: event.durMs,
        };
        emitTaskpaneDiag('fetch.response', payload, this.fetchImpl, this.maxPayloadBytes);
        if (event.ok) {
          emitTaskpaneDiag('fetch.success', payload, this.fetchImpl, this.maxPayloadBytes);
        }
        return;
      }
      case 'fetch.threw': {
        emitTaskpaneDiag(
          'fetch.threw',
          {
            op: event.op,
            url: event.url,
            requestId: event.requestId,
            durMs: event.durMs,
          },
          this.fetchImpl,
          this.maxPayloadBytes,
        );
        emitTaskpaneDiag(
          'fetch.exception',
          {
            op: event.op,
            requestId: event.requestId,
            errName: event.shape.errName,
            errMsg: event.shape.errMsg,
            errConstructor: event.shape.errConstructor,
            isDOMException: event.shape.isDOMException,
            isTypeError: event.shape.isTypeError,
            isAbortError: event.shape.isAbortError,
          },
          this.fetchImpl,
          this.maxPayloadBytes,
        );
        return;
      }
      case 'stream.open': {
        emitTaskpaneDiag(
          'stream.open',
          {
            requestId: event.requestId,
            conversationId: event.conversationId,
            ...(isNonEmptyString(event.lastEventId)
              ? { lastEventId: event.lastEventId }
              : {}),
          },
          this.fetchImpl,
          this.maxPayloadBytes,
        );
        return;
      }
      case 'stream.event': {
        emitTaskpaneDiag(
          'stream.event',
          {
            requestId: event.requestId,
            eventKind: event.eventKind,
          },
          this.fetchImpl,
          this.maxPayloadBytes,
        );
        return;
      }
      case 'stream.close': {
        emitTaskpaneDiag(
          'stream.close',
          {
            requestId: event.requestId,
            reason: event.reason,
            durMs: event.durMs,
          },
          this.fetchImpl,
          this.maxPayloadBytes,
        );
        if (event.reason === 'revoked') {
          safeEmit(() => {
            this.onAuthRevoked?.();
          });
        }
        return;
      }
      case 'stream.err': {
        emitTaskpaneDiag(
          'stream.err',
          {
            requestId: event.requestId,
            durMs: event.durMs,
            errName: event.shape.errName,
            errMsg: event.shape.errMsg,
            errConstructor: event.shape.errConstructor,
            isDOMException: event.shape.isDOMException,
            isTypeError: event.shape.isTypeError,
            isAbortError: event.shape.isAbortError,
          },
          this.fetchImpl,
          this.maxPayloadBytes,
        );
      }
    }
  }
}

/**
 * Legacy diagnostic helper preserved for compatibility. Stage 4 routes all
 * operation/stream diagnostics through shared `DiagnosticSink`s.
 */
export function diagLog(event: string, data?: Record<string, unknown>): void {
  emitTaskpaneDiag(event, data ?? {}, resolveOptionalFetch(), DIAG_MAX_PAYLOAD_BYTES);
}

function emitTaskpaneDiag(
  event: string,
  data: Record<string, unknown>,
  fetchImpl: typeof fetch | null,
  maxPayloadBytes: number,
): void {
  safeEmit(() => {
    // eslint-disable-next-line no-console
    console.log(`[rebel-taskpane-diag] ${event}`, data);
  });

  if (typeof fetchImpl !== 'function') return;

  safeEmit(() => {
    const payload = JSON.stringify({
      event,
      data,
      at: new Date().toISOString(),
      pathname: readWindowPathname(),
    });
    if (payload.length >= maxPayloadBytes) {
      return;
    }
    void fetchImpl('/diag/log', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
      credentials: 'omit',
      cache: 'no-store',
    }).catch(() => {
      // Diagnostics are best-effort and must not break chat flows.
    });
  });
}

function safeEmit(fn: () => void): void {
  try {
    fn();
  } catch {
    // Non-throwing diagnostic invariant.
  }
}

// ---------------------------------------------------------------------------
// Shared-client legacy route bridge
// ---------------------------------------------------------------------------

type SharedIntentRoute = 'create' | 'message' | 'history' | 'focus' | 'stream';

function detectSharedIntentRoute(url: string): SharedIntentRoute | null {
  if (url.endsWith('/intent/conversation/create')) return 'create';
  if (url.endsWith('/intent/conversation/message')) return 'message';
  if (url.endsWith('/intent/conversation/history')) return 'history';
  if (url.endsWith('/intent/conversation/focus')) return 'focus';
  if (url.endsWith('/intent/conversation/stream')) return 'stream';
  return null;
}

function parseBodyObject(body: BodyInit | null | undefined): Record<string, unknown> {
  if (typeof body !== 'string') return {};
  try {
    const parsed = JSON.parse(body) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function rewriteUrlPath(url: string, nextPath: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) {
    const parsed = new URL(url);
    return `${parsed.origin}${nextPath}`;
  }
  return nextPath;
}

function createLegacyRouteFetch(fetchImpl: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const originalUrl = String(input);
    const route = detectSharedIntentRoute(originalUrl);
    if (!route) {
      return fetchImpl(input, init);
    }

    const headers = new Headers(init?.headers);
    const bodyObject = parseBodyObject(init?.body);
    const conversationId =
      readString(bodyObject['conversationId']) ??
      readString(headers.get('x-rebel-conversation-id'));

    let url = originalUrl;
    let method = (init?.method ?? 'POST').toUpperCase();
    let body = init?.body;

    headers.delete('x-rebel-conversation-id');

    switch (route) {
      case 'create': {
        method = 'POST';
        break;
      }
      case 'message': {
        if (!conversationId) {
          throw createIntentError({ code: 'UNKNOWN', message: UNKNOWN_COPY });
        }
        const { conversationId: _omitConversationId, ...legacyBody } = bodyObject;
        url = rewriteUrlPath(
          originalUrl,
          `/intent/conversation/${encodeURIComponent(conversationId)}/message`,
        );
        method = 'POST';
        body = JSON.stringify(legacyBody);
        break;
      }
      case 'history': {
        if (!conversationId) {
          throw createIntentError({ code: 'UNKNOWN', message: UNKNOWN_COPY });
        }
        url = rewriteUrlPath(
          originalUrl,
          `/intent/conversation/${encodeURIComponent(conversationId)}/messages`,
        );
        method = 'GET';
        body = undefined;
        headers.delete('content-type');
        headers.delete('accept');
        break;
      }
      case 'focus': {
        if (!conversationId) {
          throw createIntentError({ code: 'UNKNOWN', message: UNKNOWN_COPY });
        }
        url = rewriteUrlPath(
          originalUrl,
          `/intent/conversation/${encodeURIComponent(conversationId)}/focus`,
        );
        method = 'POST';
        body = '{}';
        headers.set('content-type', 'application/json');
        headers.delete('accept');
        break;
      }
      case 'stream': {
        if (!conversationId) {
          throw createIntentError({ code: 'UNKNOWN', message: UNKNOWN_COPY });
        }
        url = rewriteUrlPath(
          originalUrl,
          `/intent/conversation/${encodeURIComponent(conversationId)}/stream`,
        );
        method = 'GET';
        body = undefined;
        headers.delete('content-type');
        headers.set('accept', 'text/event-stream');
        break;
      }
    }

    return fetchImpl(url, {
      ...init,
      method,
      headers,
      body,
    });
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// Runtime creation
// ---------------------------------------------------------------------------

interface RuntimeInput {
  sidecarToken: string;
  originBase?: string;
  conversationId?: string;
  fetchImpl?: typeof fetch;
}

interface RuntimeContext {
  client: IntentClient;
  transport: OfficeTransportAdapter;
}

const defaultTransport = createOfficeTransportAdapter();
const defaultBufferSink = createInMemoryDiagnosticBuffer({ capacity: 50 });
const defaultTaskpaneDiagnosticApi: TaskpaneDiagnosticApi = {
  dump: () => defaultBufferSink.dump(),
  dumpById: (requestId: string) => defaultBufferSink.dumpById(requestId),
  clear: () => defaultBufferSink.clear(),
  tailId: () => {
    const events = defaultBufferSink.dump();
    return events[events.length - 1]?.requestId ?? null;
  },
};
const defaultSidecarSink = new SidecarDiagnosticSink({
  tokenMetadataProvider: () => defaultTransport.peekTokenMetadata(),
  onAuthRevoked: () => defaultTransport.handleAuthRevoked(),
});
const defaultDiagnostics = composeDiagnosticSinks(defaultBufferSink, defaultSidecarSink);
const defaultClient = createIntentClient({
  transport: defaultTransport,
  diagnostics: defaultDiagnostics,
  fetchImpl: createLegacyRouteFetch(resolveFetchImpl()),
});

export function getTaskpaneDiagnosticApi(): TaskpaneDiagnosticApi {
  return defaultTaskpaneDiagnosticApi;
}

export function installTaskpaneDiagnosticGlobal(
  target: TaskpaneDiagnosticWindowLike,
): TaskpaneDiagnosticApi {
  const api = getTaskpaneDiagnosticApi();
  target.__rebelDiag = api;
  return api;
}

function createRuntime(input: RuntimeInput): RuntimeContext {
  const hasOverrides = Boolean(input.fetchImpl);
  if (!hasOverrides) {
    return {
      client: defaultClient,
      transport: defaultTransport,
    };
  }

  const fetchImpl = input.fetchImpl ?? resolveFetchImpl();
  const transport = createOfficeTransportAdapter({ fetchImpl });
  const bufferSink = createInMemoryDiagnosticBuffer({ capacity: 50 });
  const sidecarSink = new SidecarDiagnosticSink({
    fetchImpl,
    tokenMetadataProvider: () => transport.peekTokenMetadata(),
    onAuthRevoked: () => transport.handleAuthRevoked(),
  });
  const client = createIntentClient({
    transport,
    diagnostics: composeDiagnosticSinks(bufferSink, sidecarSink),
    fetchImpl: createLegacyRouteFetch(fetchImpl),
  });
  return { client, transport };
}

async function prepareRuntime(
  input: RuntimeInput,
): Promise<
  | { ok: true; runtime: RuntimeContext }
  | { ok: false; error: ChatErrorCode; message: string; status?: number }
> {
  if (!isNonEmptyString(input.sidecarToken)) {
    return {
      ok: false,
      error: 'PORT_UNREACHABLE',
      message: PORT_UNREACHABLE_COPY,
    };
  }

  const runtime = createRuntime(input);
  runtime.transport.setAuthHints({
    sidecarToken: input.sidecarToken,
    ...(typeof input.originBase === 'string' ? { originBase: input.originBase } : {}),
    ...(isNonEmptyString(input.conversationId)
      ? { conversationId: input.conversationId }
      : {}),
  });

  return { ok: true, runtime };
}

// ---------------------------------------------------------------------------
// Create / send / history / focus
// ---------------------------------------------------------------------------

interface AttemptFailure {
  error: unknown;
  timedOut: boolean;
}

function createAbortScope(timeoutMs: number, externalSignal?: AbortSignal): {
  signal: AbortSignal;
  timedOut: boolean;
  cleanup(): void;
} {
  let timedOut = false;
  const controller = new AbortController();
  const abort = (): void => {
    try {
      controller.abort();
    } catch {
      // abort is idempotent
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    abort();
  }, timeoutMs);

  const forwardAbort = (): void => {
    abort();
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      abort();
    } else {
      externalSignal.addEventListener('abort', forwardAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    cleanup(): void {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', forwardAbort);
    },
  };
}

async function executeWithRetry<TResult>(params: {
  runtime: RuntimeContext;
  timeoutMs: number;
  signal?: AbortSignal;
  invoke: (signal: AbortSignal) => Promise<TResult>;
}): Promise<{ ok: true; value: TResult } | { ok: false; failure: AttemptFailure }> {
  let attempt = 0;
  while (attempt < 2) {
    const scopedAbort = createAbortScope(params.timeoutMs, params.signal);

    try {
      const value = await params.invoke(scopedAbort.signal);
      return { ok: true, value };
    } catch (error) {
      if (!scopedAbort.timedOut && attempt === 0 && isUnauthorizedIntentError(error)) {
        params.runtime.transport.handleUnauthorizedResponse();
        attempt += 1;
        continue;
      }
      return {
        ok: false,
        failure: { error, timedOut: scopedAbort.timedOut },
      };
    } finally {
      scopedAbort.cleanup();
    }
  }

  return {
    ok: false,
    failure: {
      error: createIntentError({ code: 'UNKNOWN', message: UNKNOWN_COPY }),
      timedOut: false,
    },
  };
}

export async function createConversation(
  input: CreateConversationInput,
): Promise<CreateConversationResult> {
  const prepared = await prepareRuntime({
    sidecarToken: input.sidecarToken,
    ...(typeof input.originBase === 'string' ? { originBase: input.originBase } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
  if (!prepared.ok) {
    return prepared;
  }

  const attempted = await executeWithRetry({
    runtime: prepared.runtime,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(input.signal ? { signal: input.signal } : {}),
    invoke: (signal) =>
      prepared.runtime.client.createConversation(
        {
          intent: input.intent,
          ...(input.documentContext ? { documentContext: input.documentContext } : {}),
          switchToConversation: input.switchToConversation ?? false,
          ...(input.pageContext ? { pageContext: input.pageContext } : {}),
          ...(isNonEmptyString(input.userText) ? { userText: input.userText } : {}),
          ...(isNonEmptyString(input.title) ? { title: input.title } : {}),
        },
        signal,
      ),
  });

  if (!attempted.ok) {
    return {
      ok: false,
      ...toLegacyErrorEnvelope(attempted.failure.error, attempted.failure.timedOut),
    };
  }

  const result = attempted.value;
  return {
    ok: true,
    conversationId: result.conversationId,
    ...(result.state ? { state: result.state } : {}),
  };
}

export async function sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
  const prepared = await prepareRuntime({
    sidecarToken: input.sidecarToken,
    ...(typeof input.originBase === 'string' ? { originBase: input.originBase } : {}),
    conversationId: input.conversationId,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
  if (!prepared.ok) {
    return prepared;
  }

  const attempted = await executeWithRetry({
    runtime: prepared.runtime,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(input.signal ? { signal: input.signal } : {}),
    invoke: (signal) =>
      prepared.runtime.client.sendMessage(
        {
          conversationId: input.conversationId,
          text: input.text,
          ...(input.documentContext ? { documentContext: input.documentContext } : {}),
        },
        signal,
      ),
  });

  if (!attempted.ok) {
    return {
      ok: false,
      ...toLegacyErrorEnvelope(attempted.failure.error, attempted.failure.timedOut),
    };
  }

  return {
    ok: true,
    messageId: attempted.value.messageId,
    state: attempted.value.state,
    queueSize: attempted.value.queueSize,
  };
}

export async function getHistory(input: GetHistoryInput): Promise<GetHistoryResult> {
  const prepared = await prepareRuntime({
    sidecarToken: input.sidecarToken,
    ...(typeof input.originBase === 'string' ? { originBase: input.originBase } : {}),
    conversationId: input.conversationId,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
  if (!prepared.ok) {
    return prepared;
  }

  const attempted = await executeWithRetry({
    runtime: prepared.runtime,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(input.signal ? { signal: input.signal } : {}),
    invoke: (signal) =>
      prepared.runtime.client.getHistory(
        {
          conversationId: input.conversationId,
        },
        signal,
      ),
  });

  if (!attempted.ok) {
    return {
      ok: false,
      ...toLegacyErrorEnvelope(attempted.failure.error, attempted.failure.timedOut),
    };
  }

  return {
    ok: true,
    messages: attempted.value.messages,
    turnStatus: attempted.value.turnStatus,
    ...(isNonEmptyString(attempted.value.conversationTitle)
      ? { conversationTitle: attempted.value.conversationTitle }
      : {}),
  };
}

export async function focusInRebel(input: FocusInRebelInput): Promise<FocusInRebelResult> {
  const prepared = await prepareRuntime({
    sidecarToken: input.sidecarToken,
    ...(typeof input.originBase === 'string' ? { originBase: input.originBase } : {}),
    conversationId: input.conversationId,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
  if (!prepared.ok) {
    return prepared;
  }

  const attempted = await executeWithRetry({
    runtime: prepared.runtime,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(input.signal ? { signal: input.signal } : {}),
    invoke: (signal) =>
      prepared.runtime.client.focusInRebel(
        {
          conversationId: input.conversationId,
        },
        signal,
      ),
  });

  if (!attempted.ok) {
    return {
      ok: false,
      ...toLegacyErrorEnvelope(attempted.failure.error, attempted.failure.timedOut),
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// connectStream
// ---------------------------------------------------------------------------

export function connectStream(input: ConnectStreamInput): StreamConnection {
  if (!isNonEmptyString(input.sidecarToken)) {
    input.onError?.(new Error('PORT_UNREACHABLE'));
    input.onClose?.('error');
    return {
      close() {
        // no-op
      },
    };
  }

  const runtime = createRuntime({
    sidecarToken: input.sidecarToken,
    ...(typeof input.originBase === 'string' ? { originBase: input.originBase } : {}),
    conversationId: input.conversationId,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });

  runtime.transport.setAuthHints({
    sidecarToken: input.sidecarToken,
    ...(typeof input.originBase === 'string' ? { originBase: input.originBase } : {}),
    conversationId: input.conversationId,
  });

  const controller = new AbortController();
  let closed = false;
  let closeNotified = false;
  let connection: { close(): void } | null = null;

  const notifyClose = (reason: StreamCloseReason): void => {
    if (closeNotified) return;
    closeNotified = true;
    input.onClose?.(reason);
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    try {
      controller.abort();
    } catch {
      // abort is idempotent
    }
    connection?.close();
    if (!connection) {
      notifyClose('aborted');
    }
  };

  if (input.signal) {
    if (input.signal.aborted) {
      close();
    } else {
      input.signal.addEventListener('abort', close, { once: true });
    }
  }

  connection = runtime.client.connectStream(
    {
      conversationId: input.conversationId,
      signal: controller.signal,
    },
    {
      onEvent: (event) => {
        input.onEvent(event);
      },
      onError: (error) => {
        if (closed) return;
        input.onError?.(toLegacyStreamError(error));
      },
      onClose: (reason) => {
        if (reason === 'revoked') {
          runtime.transport.handleAuthRevoked();
        }
        notifyClose(reason);
      },
    },
  );

  return { close };
}

export async function probeReachability(
  input: Pick<BridgeConfig, 'sidecarToken' | 'originBase'> & { fetchImpl?: typeof fetch },
): Promise<boolean> {
  const prepared = await prepareRuntime({
    sidecarToken: input.sidecarToken,
    ...(typeof input.originBase === 'string' ? { originBase: input.originBase } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
  if (!prepared.ok) {
    return false;
  }

  return prepared.runtime.transport.isReachable(input.fetchImpl);
}

// ---------------------------------------------------------------------------
// parseSSEChunk compatibility export
// ---------------------------------------------------------------------------

export function parseSSEChunk(buffer: string): {
  events: Array<{ event: string; data: string }>;
  remaining: string;
} {
  const parsed = parseSharedSSEChunk(buffer);
  return {
    events: parsed.events,
    remaining: parsed.remainder,
  };
}

// ---------------------------------------------------------------------------
// Error mapping helpers
// ---------------------------------------------------------------------------

function mapSharedCodeToLegacy(code: SharedChatErrorCode): ChatErrorCode {
  switch (code) {
    case 'UNSUPPORTED':
      return 'NOT_IMPLEMENTED';
    case 'BRIDGE_UNAVAILABLE':
      return 'APP_NOT_CONNECTED';
    case 'BRIDGE_ERROR':
      return 'INTERNAL_ERROR';
    case 'FORBIDDEN':
    case 'REVOKED':
      return 'UNAUTHORIZED';
    case 'GONE':
      return 'NOT_FOUND';
    case 'ABORTED':
      return 'TIMEOUT';
    case 'NOT_IMPLEMENTED':
    case 'NOT_FOUND':
    case 'APP_NOT_CONNECTED':
    case 'PORT_UNREACHABLE':
    case 'NETWORK_ERROR':
    case 'TIMEOUT':
    case 'BAD_REQUEST':
    case 'UNAUTHORIZED':
    case 'INTERNAL_ERROR':
    case 'UNKNOWN':
      return code;
  }
}

function defaultLegacyMessage(code: ChatErrorCode, status?: number): string {
  switch (code) {
    case 'PORT_UNREACHABLE':
      return PORT_UNREACHABLE_COPY;
    case 'NETWORK_ERROR':
      return NETWORK_ERROR_COPY;
    case 'TIMEOUT':
      return TIMEOUT_COPY;
    case 'NOT_IMPLEMENTED':
      return NOT_IMPLEMENTED_COPY;
    case 'APP_NOT_CONNECTED':
      return APP_NOT_CONNECTED_COPY;
    case 'UNAUTHORIZED':
      return UNAUTHORIZED_COPY;
    case 'BAD_REQUEST':
      return BAD_REQUEST_COPY;
    case 'NOT_FOUND':
      return NOT_FOUND_COPY;
    case 'INTERNAL_ERROR':
      return typeof status === 'number'
        ? `Rebel returned an unexpected ${status}.`
        : 'Rebel returned an unexpected server error.';
    case 'UNKNOWN':
    default:
      return UNKNOWN_COPY;
  }
}

function toLegacyErrorEnvelope(
  error: unknown,
  timedOut = false,
): { error: ChatErrorCode; message: string; status?: number } {
  if (timedOut) {
    return { error: 'TIMEOUT', message: TIMEOUT_COPY };
  }

  if (isIntentClientErrorLike(error)) {
    const code = mapSharedCodeToLegacy(error.code);
    const message = selectLegacyMessage(code, error.message, error.status);
    return {
      error: code,
      message,
      ...(typeof error.status === 'number' ? { status: error.status } : {}),
    };
  }

  if (error instanceof Error && error.message === 'PORT_UNREACHABLE') {
    return { error: 'PORT_UNREACHABLE', message: PORT_UNREACHABLE_COPY };
  }

  return { error: 'UNKNOWN', message: UNKNOWN_COPY };
}

function toLegacyStreamError(error: ConnectStreamError): Error {
  if (isResponseError(error)) {
    const code = mapSharedCodeToLegacy(error.code);
    const message = selectLegacyMessage(code, error.message, error.status);
    return new Error(`${code}: ${message}`);
  }

  if (error.isAbortError) {
    return new Error(`TIMEOUT: ${TIMEOUT_COPY}`);
  }
  if (error.isTypeError || error.isDOMException) {
    return new Error(`NETWORK_ERROR: ${NETWORK_ERROR_COPY}`);
  }
  return new Error(`UNKNOWN: ${UNKNOWN_COPY}`);
}

function selectLegacyMessage(
  code: ChatErrorCode,
  message: string,
  status?: number,
): string {
  if (code === 'TIMEOUT') return TIMEOUT_COPY;
  if (code === 'NETWORK_ERROR') return NETWORK_ERROR_COPY;
  if (code === 'PORT_UNREACHABLE') return PORT_UNREACHABLE_COPY;
  if (code === 'UNAUTHORIZED') return UNAUTHORIZED_COPY;
  if (isNonEmptyString(message)) {
    return message;
  }
  return defaultLegacyMessage(code, status);
}

function createIntentError(input: {
  code: SharedChatErrorCode;
  message: string;
  status?: number;
}): IntentClientError {
  const error = new Error(input.message) as IntentClientError;
  error.name = 'IntentClientError';
  error.code = input.code;
  if (typeof input.status === 'number') {
    error.status = input.status;
  }
  return error;
}

function isIntentClientErrorLike(error: unknown): error is IntentClientError {
  if (!(error instanceof Error)) return false;
  if (!isRecord(error)) return false;
  return isNonEmptyString(error.code);
}

function isUnauthorizedIntentError(error: unknown): boolean {
  if (isIntentClientErrorLike(error)) {
    return error.code === 'UNAUTHORIZED' || error.status === 401;
  }
  if (isResponseError(error)) {
    return error.code === 'UNAUTHORIZED' || error.status === 401;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function resolveFetchImpl(): typeof fetch {
  if (typeof fetch === 'function') {
    return fetch;
  }
  return (async () => {
    throw new Error('fetch is not available in this environment.');
  }) as typeof fetch;
}

function resolveOptionalFetch(): typeof fetch | null {
  return typeof fetch === 'function' ? fetch : null;
}

function resolveDiagPingUrl(baseUrl: string): string {
  const trimmedBase = trimTrailingSlash(baseUrl);
  return trimmedBase.length > 0 ? `${trimmedBase}/diag/ping` : '/diag/ping';
}

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function readWindowPathname(): string | undefined {
  const maybeWindow = globalThis as typeof globalThis & {
    window?: {
      location?: {
        pathname?: unknown;
      };
    };
  };
  const pathname = maybeWindow.window?.location?.pathname;
  return typeof pathname === 'string' ? pathname : undefined;
}

function readWindowSidecarToken(): string | null {
  const maybeGlobal = globalThis as typeof globalThis & {
    __REBEL_SIDECAR_CONFIG?: {
      token?: unknown;
    };
    window?: {
      __REBEL_SIDECAR_CONFIG?: {
        token?: unknown;
      };
    };
  };
  const token =
    maybeGlobal.window?.__REBEL_SIDECAR_CONFIG?.token ??
    maybeGlobal.__REBEL_SIDECAR_CONFIG?.token;
  return readString(token);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function readString(value: unknown): string | null {
  return isNonEmptyString(value) ? value : null;
}

export type { ChatState } from './chatState.js';
export { clearChatState, getChatState, setChatState } from './chatState.js';

// ---------------------------------------------------------------------------
// Test-only helpers
// ---------------------------------------------------------------------------

export const __diagRequestIdRegex = DIAG_REQUEST_ID_RE;
