import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __diagRequestIdRegex,
  connectStream,
  createConversation,
  getHistory,
  sendMessage,
} from '../src/addin/chatClient.js';
import {
  IntentConversationCreateSchema,
  IntentConversationMessageSchema,
} from '../src/shared/appBridge/shared/intentProtocol.js';

type SidecarWindow = {
  __REBEL_SIDECAR_CONFIG?: { token?: string };
  location?: { pathname?: string };
};

type DiagPayload = {
  event?: string;
  data?: Record<string, unknown>;
  at?: string;
  pathname?: string;
};

const globalObject = globalThis as typeof globalThis & {
  window?: SidecarWindow;
};
const originalWindow = globalObject.window;

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  if (originalWindow === undefined) {
    Reflect.deleteProperty(globalObject, 'window');
  } else {
    globalObject.window = originalWindow;
  }
});

function setWindowToken(token: string): void {
  globalObject.window = {
    ...(globalObject.window ?? {}),
    __REBEL_SIDECAR_CONFIG: { token },
    location: { pathname: '/taskpane.html' },
  };
}

function isDiagLogUrl(url: string): boolean {
  return url === '/diag/log' || url.endsWith('/diag/log');
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sseResponse(chunks: string[], errorAfterChunks?: unknown): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      if (errorAfterChunks !== undefined) {
        controller.error(errorAfterChunks);
        return;
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function waitForCloseReason(
  start: (onClose: (reason: 'eof' | 'aborted' | 'error' | 'revoked') => void) => void,
): Promise<'eof' | 'aborted' | 'error' | 'revoked'> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for close reason')), 2_000);
    start((reason) => {
      clearTimeout(timer);
      resolve(reason);
    });
  });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('office chatClient migration (Stage 4)', () => {
  it('retries once on 401 and uses a refreshed Authorization token', async () => {
    setWindowToken('minted-token-1');

    const operationAuthHeaders: string[] = [];

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (isDiagLogUrl(url)) {
        return new Response(null, { status: 204 });
      }

      if (url.endsWith('/intent/conversation/conv-401/message')) {
        const headers = new Headers(init?.headers);
        operationAuthHeaders.push(headers.get('authorization') ?? '');

        if (operationAuthHeaders.length === 1) {
          setWindowToken('minted-token-2');
          return jsonResponse({ message: 'first token rejected' }, 401);
        }

        return jsonResponse({
          success: true,
          conversationId: 'conv-401',
          messageId: 'msg-1',
          state: 'submitted',
          queueSize: 0,
        });
      }

      throw new Error(`Unexpected request URL: ${url}`);
    });

    const result = await sendMessage({
      sidecarToken: 'fallback-token',
      originBase: 'https://127.0.0.1:3000',
      conversationId: 'conv-401',
      text: 'hello',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).toEqual({
      ok: true,
      messageId: 'msg-1',
      state: 'submitted',
      queueSize: 0,
    });
    expect(operationAuthHeaders).toEqual([
      'Bearer minted-token-1',
      'Bearer minted-token-2',
    ]);
  });

  it('invalidates cached token on revoked stream close and mints fresh token for next operation', async () => {
    setWindowToken('revoked-token');

    let historyAuthHeader: string | null = null;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (isDiagLogUrl(url)) {
        return new Response(null, { status: 204 });
      }

      if (url.endsWith('/intent/conversation/conv-r2/stream')) {
        return sseResponse([
          'event: connected\ndata: {"conversationId":"conv-r2","turnStatus":"idle"}\n\n',
          'event: revoked\ndata: {"reason":"token_revoked"}\n\n',
        ]);
      }

      if (url.endsWith('/intent/conversation/conv-r2/messages')) {
        const headers = new Headers(init?.headers);
        historyAuthHeader = headers.get('authorization');
        return jsonResponse({
          success: true,
          conversationId: 'conv-r2',
          messages: [],
          turnStatus: 'idle',
        });
      }

      throw new Error(`Unexpected request URL: ${url}`);
    });

    const closeReason = await waitForCloseReason((onClose) => {
      connectStream({
        sidecarToken: 'fallback-token',
        originBase: 'https://127.0.0.1:3000',
        conversationId: 'conv-r2',
        fetchImpl: fetchMock as unknown as typeof fetch,
        onEvent: () => undefined,
        onError: () => undefined,
        onClose,
      });
    });

    expect(closeReason).toBe('revoked');

    setWindowToken('fresh-token-after-revoke');

    const history = await getHistory({
      sidecarToken: 'fallback-token',
      originBase: 'https://127.0.0.1:3000',
      conversationId: 'conv-r2',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(history.ok).toBe(true);
    expect(historyAuthHeader).toBe('Bearer fresh-token-after-revoke');
  });

  it('forwards fetch/stream diagnostics to /diag/log with valid requestIds', async () => {
    setWindowToken('diag-token');

    const diagPayloads: DiagPayload[] = [];

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (isDiagLogUrl(url)) {
        const rawBody = typeof init?.body === 'string' ? init.body : '{}';
        diagPayloads.push(JSON.parse(rawBody) as DiagPayload);
        return new Response(null, { status: 204 });
      }

      if (url.endsWith('/intent/conversation/create')) {
        return jsonResponse({ success: true, conversationId: 'conv-diag', state: 'new' });
      }

      if (url.endsWith('/intent/conversation/conv-diag/message')) {
        throw new TypeError('network exploded');
      }

      if (url.endsWith('/intent/conversation/conv-diag/stream')) {
        return sseResponse([
          'event: connected\ndata: {"conversationId":"conv-diag","turnStatus":"idle"}\n\n',
        ]);
      }

      throw new Error(`Unexpected request URL: ${url}`);
    });

    const created = await createConversation({
      sidecarToken: 'fallback-token',
      originBase: 'https://127.0.0.1:3000',
      intent: 'chat',
      userText: 'diag create',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(created.ok).toBe(true);

    const sent = await sendMessage({
      sidecarToken: 'fallback-token',
      originBase: 'https://127.0.0.1:3000',
      conversationId: 'conv-diag',
      text: 'diag send',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(sent.ok).toBe(false);

    const closeReason = await waitForCloseReason((onClose) => {
      connectStream({
        sidecarToken: 'fallback-token',
        originBase: 'https://127.0.0.1:3000',
        conversationId: 'conv-diag',
        fetchImpl: fetchMock as unknown as typeof fetch,
        onEvent: () => undefined,
        onError: () => undefined,
        onClose,
      });
    });
    expect(closeReason).toBe('eof');

    await vi.waitFor(() => {
      const names = new Set(diagPayloads.map((entry) => entry.event));
      expect(names.has('fetch.start')).toBe(true);
      expect(names.has('fetch.success')).toBe(true);
      expect(names.has('fetch.threw')).toBe(true);
      expect(names.has('stream.open')).toBe(true);
      expect(names.has('stream.close')).toBe(true);
    });

    const required = diagPayloads.filter((entry) =>
      ['fetch.start', 'fetch.success', 'fetch.threw', 'stream.open', 'stream.close'].includes(
        String(entry.event),
      ));

    expect(required.length).toBeGreaterThan(0);
    for (const payload of required) {
      const requestId = payload.data?.requestId;
      expect(typeof requestId).toBe('string');
      expect(__diagRequestIdRegex.test(String(requestId))).toBe(true);
    }

    await flushMicrotasks();
  });

  it("connectStream forwards close reasons for 'eof', 'revoked', and 'error'", async () => {
    const runCase = async (mode: 'eof' | 'revoked' | 'error') => {
      setWindowToken(`stream-token-${mode}`);
      const streamErrors: Error[] = [];

      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (isDiagLogUrl(url)) {
          return new Response(null, { status: 204 });
        }
        if (!url.endsWith('/intent/conversation/conv-stream/stream')) {
          throw new Error(`Unexpected request URL: ${url}`);
        }

        if (mode === 'eof') {
          return sseResponse([
            'event: connected\ndata: {"conversationId":"conv-stream","turnStatus":"idle"}\n\n',
          ]);
        }
        if (mode === 'revoked') {
          return sseResponse(['event: revoked\ndata: {"reason":"token_revoked"}\n\n']);
        }
        return sseResponse(
          ['event: connected\ndata: {"conversationId":"conv-stream","turnStatus":"idle"}\n\n'],
          new TypeError('reader boom'),
        );
      });

      const closeReason = await waitForCloseReason((onClose) => {
        connectStream({
          sidecarToken: 'fallback-token',
          originBase: 'https://127.0.0.1:3000',
          conversationId: 'conv-stream',
          fetchImpl: fetchMock as unknown as typeof fetch,
          onEvent: () => undefined,
          onError: (error) => {
            streamErrors.push(error);
          },
          onClose,
        });
      });

      if (mode === 'error') {
        expect(streamErrors.length).toBeGreaterThan(0);
      }

      expect(closeReason).toBe(mode);
    };

    await runCase('eof');
    await runCase('revoked');
    await runCase('error');
  });

  it('does not send extension identity headers from the Office adapter', async () => {
    setWindowToken('header-token');

    let capturedHeaders: Headers | null = null;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (isDiagLogUrl(url)) {
        return new Response(null, { status: 204 });
      }

      if (url.endsWith('/intent/conversation/create')) {
        capturedHeaders = new Headers(init?.headers);
        return jsonResponse({ success: true, conversationId: 'conv-header', state: 'new' });
      }

      throw new Error(`Unexpected request URL: ${url}`);
    });

    const result = await createConversation({
      sidecarToken: 'fallback-token',
      originBase: 'https://127.0.0.1:3000',
      intent: 'chat',
      userText: 'header test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    expect(capturedHeaders?.get('authorization')).toBe('Bearer header-token');
    expect(capturedHeaders?.get('x-rebel-diag-id')).toMatch(__diagRequestIdRegex);
    expect(capturedHeaders?.get('x-rebel-app-id')).toBeNull();
    expect(capturedHeaders?.get('x-rebel-client-id')).toBeNull();
    expect(capturedHeaders?.get('x-rebel-client-fingerprint')).toBeNull();
  });

  it('produces canonical create/message bodies once the sidecar stamps app and client ids', async () => {
    setWindowToken('schema-token');

    let createBody: Record<string, unknown> | null = null;
    let messageBody: Record<string, unknown> | null = null;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (isDiagLogUrl(url)) {
        return new Response(null, { status: 204 });
      }

      if (url.endsWith('/intent/conversation/create')) {
        createBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return jsonResponse({ success: true, conversationId: 'conv-schema', state: 'new' });
      }

      if (url.endsWith('/intent/conversation/conv-schema/message')) {
        messageBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return jsonResponse({
          success: true,
          conversationId: 'conv-schema',
          messageId: 'msg-schema',
          state: 'submitted',
          queueSize: 0,
        });
      }

      throw new Error(`Unexpected request URL: ${url}`);
    });

    await createConversation({
      sidecarToken: 'fallback-token',
      originBase: 'https://127.0.0.1:3000',
      intent: 'chat',
      userText: 'schema create',
      documentContext: {
        host: 'word',
        title: 'Quarterly Plan.docx',
        url: 'file:///Quarterly%20Plan.docx',
      },
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await sendMessage({
      sidecarToken: 'fallback-token',
      originBase: 'https://127.0.0.1:3000',
      conversationId: 'conv-schema',
      text: 'schema message',
      documentContext: {
        host: 'word',
        title: 'Quarterly Plan.docx',
        url: 'file:///Quarterly%20Plan.docx',
      },
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(createBody).not.toBeNull();
    expect(messageBody).not.toBeNull();
    expect(createBody?.documentContext).toEqual({
      host: 'word',
      title: 'Quarterly Plan.docx',
      url: 'file:///Quarterly%20Plan.docx',
    });
    expect(messageBody?.documentContext).toEqual({
      host: 'word',
      title: 'Quarterly Plan.docx',
      url: 'file:///Quarterly%20Plan.docx',
    });

    expect(() =>
      IntentConversationCreateSchema.parse({
        ...createBody,
        appId: 'office-addin',
        clientId: 'bridge-client-office',
      }),
    ).not.toThrow();
    expect(() =>
      IntentConversationMessageSchema.parse({
        ...messageBody,
        appId: 'office-addin',
        clientId: 'bridge-client-office',
      }),
    ).not.toThrow();
  });
});
