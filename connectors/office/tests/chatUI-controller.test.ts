// @vitest-environment happy-dom

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ConnectStreamHandlers,
  IntentClient,
  IntentClientError,
} from '../src/shared/intentClient/index.js';
import { createInMemoryChatStatePersistence } from '../src/shared/intentClient/persistence.js';
import type { DocumentContext } from '../src/addin/chatClient.js';
import {
  copyChatStateBetweenScopes,
  createOfficeScopedLocalStoragePersistence,
  getInitialSnapshot as readOfficeInitialSnapshot,
} from '../src/addin/chatState.js';
import { createChatUI } from '../src/addin/chatUI.js';
import { createOfficeDocumentContextProvider } from '../src/addin/documentContextProvider.js';
import { resolveOfficeDocumentScope } from '../src/addin/documentScope.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, '..');
const DEFAULT_DOCUMENT_CONTEXT = {
  host: 'word',
  title: 'Quarterly Plan.docx',
  url: 'file:///Quarterly%20Plan.docx',
};
const DEFAULT_BRIDGE_CONFIG = {
  sidecarToken: 'office-token',
  originBase: 'https://127.0.0.1:3000',
};

interface ClientHarness {
  client: IntentClient;
  connectHandlers: ConnectStreamHandlers[];
  createConversation: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  getHistory: ReturnType<typeof vi.fn>;
  focusInRebel: ReturnType<typeof vi.fn>;
  streamClose: ReturnType<typeof vi.fn>;
}

function createIntentError(
  code: IntentClientError['code'],
  message: string,
  status?: number,
): IntentClientError {
  const error = new Error(message) as IntentClientError;
  error.name = 'IntentClientError';
  error.code = code;
  if (typeof status === 'number') {
    error.status = status;
  }
  return error;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createClientHarness(): ClientHarness {
  const connectHandlers: ConnectStreamHandlers[] = [];
  const streamClose = vi.fn();
  const createConversation = vi.fn(async () => ({
    conversationId: 'conv-1',
    state: 'new' as const,
  }));
  const sendMessage = vi.fn(async () => ({
    conversationId: 'conv-1',
    messageId: 'msg-1',
    state: 'submitted' as const,
    queueSize: 0,
  }));
  const getHistory = vi.fn(async () => ({
    conversationId: 'conv-1',
    messages: [],
    turnStatus: 'idle' as const,
  }));
  const focusInRebel = vi.fn(async () => ({
    conversationId: 'conv-1',
    focused: true,
  }));

  return {
    connectHandlers,
    createConversation,
    sendMessage,
    getHistory,
    focusInRebel,
    streamClose,
    client: {
      createConversation,
      sendMessage,
      getHistory,
      focusInRebel,
      connectStream: (_input, handlers) => {
        connectHandlers.push(handlers);
        return {
          close: streamClose,
        };
      },
    },
  };
}

function mountChatUI(options: {
  harness?: ClientHarness;
  probeReachability?: boolean;
  initialSnapshot?: {
    conversationId: string;
    createdAt?: number;
    pageTitle?: string;
    pageUrl?: string;
  } | null;
} = {}) {
  const harness = options.harness ?? createClientHarness();
  const persistence = createInMemoryChatStatePersistence(options.initialSnapshot ?? null);
  const container = document.createElement('div');
  document.body.innerHTML = '';
  document.body.appendChild(container);

  const chatUI = createChatUI(
    {
      container,
      bridgeConfig: DEFAULT_BRIDGE_CONFIG,
      documentContext: DEFAULT_DOCUMENT_CONTEXT,
    },
    {
      createIntentClient: () => harness.client,
      persistence,
      getInitialSnapshot: () => options.initialSnapshot ?? null,
      probeReachability: async () => options.probeReachability ?? true,
    },
  );

  return { chatUI, container, harness, persistence };
}

function getTextarea(container: HTMLElement): HTMLTextAreaElement {
  const textarea = container.querySelector('.chat-composer-textarea');
  expect(textarea).not.toBeNull();
  return textarea as HTMLTextAreaElement;
}

function getSendButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector('.chat-composer-send');
  expect(button).not.toBeNull();
  return button as HTMLButtonElement;
}

function getHeader(container: HTMLElement): HTMLElement {
  const header = container.querySelector('.chat-header');
  expect(header).not.toBeNull();
  return header as HTMLElement;
}

function getConversationBanner(container: HTMLElement): HTMLElement {
  const banner = container.querySelector('.chat-error');
  expect(banner).not.toBeNull();
  return banner as HTMLElement;
}

function getOpenButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector(
    '.chat-header-btn[aria-label=\"Open in Rebel\"]',
  );
  expect(button).not.toBeNull();
  return button as HTMLButtonElement;
}

function getStartFreshButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector(
    '.chat-header-btn[aria-label=\"Start fresh\"]',
  );
  expect(button).not.toBeNull();
  return button as HTMLButtonElement;
}

function sendComposerMessage(container: HTMLElement, text: string): void {
  const textarea = getTextarea(container);
  textarea.value = text;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
    }),
  );
}

function collectSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      return collectSourceFiles(fullPath);
    }
    return fullPath.endsWith('.ts') || fullPath.endsWith('.tsx') ? [fullPath] : [];
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('office chatUI shared rendering migration (Stage 10)', () => {
  it('renders a not-ready header and does not mount the controller when bridgeConfig is null (bridgeReady=false)', () => {
    const harness = createClientHarness();
    const createIntentClient = vi.fn(() => harness.client);
    const getInitialSnapshot = vi.fn(() => null);
    const container = document.createElement('div');
    document.body.innerHTML = '';
    document.body.appendChild(container);

    createChatUI(
      {
        container,
        bridgeConfig: null,
        documentContext: DEFAULT_DOCUMENT_CONTEXT,
      },
      {
        createIntentClient,
        persistence: createInMemoryChatStatePersistence(null),
        getInitialSnapshot,
        probeReachability: async () => true,
      },
    );

    expect(getHeader(container).dataset.status).toBe('not-ready');
    expect(container.textContent).toContain('Rebel is setting up');
    expect(getTextarea(container).disabled).toBe(true);
    expect(getSendButton(container).disabled).toBe(true);
    expect(createIntentClient).not.toHaveBeenCalled();
    expect(getInitialSnapshot).not.toHaveBeenCalled();
  });

  it('renders send/stream happy path and keeps open-in-Rebel working', async () => {
    const harness = createClientHarness();
    harness.getHistory.mockResolvedValueOnce({
      conversationId: 'conv-1',
      messages: [{ id: 'user-1', role: 'user', text: 'hello', createdAt: 1 }],
      turnStatus: 'running' as const,
    });

    const { container } = mountChatUI({ harness });

    sendComposerMessage(container, 'hello');

    await vi.waitFor(() => {
      expect(harness.createConversation).toHaveBeenCalledTimes(1);
      expect(container.textContent).toContain('hello');
      expect(harness.connectHandlers).toHaveLength(1);
    });

    harness.connectHandlers[0]?.onEvent({
      type: 'connected',
      conversationId: 'conv-1',
      turnStatus: 'running',
    });
    harness.connectHandlers[0]?.onEvent({ type: 'turn_started', turnId: 'turn-1' });
    harness.connectHandlers[0]?.onEvent({
      type: 'assistant_delta',
      turnId: 'turn-1',
      text: 'Hello from Rebel',
    });
    harness.connectHandlers[0]?.onEvent({ type: 'assistant_done', turnId: 'turn-1' });
    harness.connectHandlers[0]?.onEvent({
      type: 'message_added',
      message: {
        id: 'assistant-1',
        role: 'assistant',
        text: 'Hello from Rebel',
        createdAt: 2,
      },
    });

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Hello from Rebel');
      expect(getOpenButton(container).disabled).toBe(false);
    });

    getOpenButton(container).click();

    await vi.waitFor(() => {
      expect(harness.focusInRebel).toHaveBeenCalledWith(
        { conversationId: 'conv-1' },
        expect.any(AbortSignal),
      );
    });
  });

  it('refreshes document context before send and redacts URLs from controller context', async () => {
    const harness = createClientHarness();
    const container = document.createElement('div');
    document.body.innerHTML = '';
    document.body.appendChild(container);

    let currentContext: DocumentContext = { host: 'word' };
    const resolveCalls: DocumentContext[] = [];

    createChatUI(
      {
        container,
        bridgeConfig: DEFAULT_BRIDGE_CONFIG,
        documentContext: currentContext,
        getDocumentContext: () => currentContext,
      },
      {
        createIntentClient: () => harness.client,
        createScopedPersistence: (scope) => createOfficeScopedLocalStoragePersistence(scope),
        getInitialSnapshot: () => null,
        probeReachability: async () => true,
        resolveDocumentScope: async (context, taskpaneSessionId) => {
          resolveCalls.push(context);
          if (context.url) {
            return {
              scope: {
                key: 'office-durable:install:doc-saved',
                mode: 'durable' as const,
                host: context.host,
                title: context.title,
                url: context.url,
                settingsId: 'doc-saved',
                fingerprint: 'fingerprint-saved',
              },
              sanitizedContext: context,
              reason: 'created-durable' as const,
            };
          }
          return {
            scope: {
              key: `office-ephemeral:install:${taskpaneSessionId}`,
              mode: 'ephemeral' as const,
              host: context.host,
              taskpaneSessionId,
            },
            sanitizedContext: context,
            reason: 'unsaved-document' as const,
          };
        },
      },
    );

    await vi.waitFor(() => {
      expect(getTextarea(container).disabled).toBe(false);
    });

    currentContext = {
      host: 'word',
      title: 'Saved Draft.docx',
      url: 'file:///Users/someone/Documents/Saved%20Draft.docx',
    };
    sendComposerMessage(container, 'summarise this');

    await vi.waitFor(() => {
      expect(harness.createConversation).toHaveBeenCalledTimes(1);
    });

    expect(resolveCalls.at(-1)).toEqual(currentContext);
    expect(harness.createConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        documentContext: {
          host: 'word',
          title: 'Saved Draft.docx',
        },
        pageContext: {
          title: 'Saved Draft.docx',
        },
      }),
      expect.any(AbortSignal),
    );
    expect(harness.createConversation.mock.calls[0]?.[0]).not.toHaveProperty(
      'documentContext.url',
    );
  });

  it('does not remount the controller for same-scope focus refreshes', async () => {
    const harness = createClientHarness();
    const container = document.createElement('div');
    document.body.innerHTML = '';
    document.body.appendChild(container);
    const createIntentClient = vi.fn(() => harness.client);
    const durableScope = {
      key: 'office-durable:install:doc-same',
      mode: 'durable' as const,
      host: 'word',
      title: 'Saved Draft.docx',
      settingsId: 'doc-same',
      fingerprint: 'fingerprint-same',
    };

    const chatUI = createChatUI(
      {
        container,
        bridgeConfig: DEFAULT_BRIDGE_CONFIG,
        documentContext: {
          host: 'word',
          title: 'Saved Draft.docx',
          url: 'file:///Saved%20Draft.docx',
        },
      },
      {
        createIntentClient,
        createScopedPersistence: (scope) => createOfficeScopedLocalStoragePersistence(scope),
        getInitialSnapshot: () => null,
        probeReachability: async () => true,
        resolveDocumentScope: async (context) => ({
          scope: durableScope,
          sanitizedContext: context,
          reason: 'resolved-durable' as const,
        }),
      },
    );

    await vi.waitFor(() => {
      expect(getTextarea(container).disabled).toBe(false);
      expect(createIntentClient).toHaveBeenCalledTimes(1);
    });

    chatUI.setDocumentContext({
      host: 'word',
      title: 'Saved Draft.docx',
      url: 'file:///Saved%20Draft.docx',
    });

    await Promise.resolve();
    await vi.waitFor(() => {
      expect(getTextarea(container).disabled).toBe(false);
    });
    expect(createIntentClient).toHaveBeenCalledTimes(1);
  });

  it('does not migrate unsaved Office chat into a durable scope without fingerprint proof', async () => {
    const harness = createClientHarness();
    const container = document.createElement('div');
    document.body.innerHTML = '';
    document.body.appendChild(container);
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    let currentContext: DocumentContext = {
      host: 'word',
      title: 'Draft',
    };

    const chatUI = createChatUI(
      {
        container,
        bridgeConfig: DEFAULT_BRIDGE_CONFIG,
        documentContext: currentContext,
        getDocumentContext: () => currentContext,
      },
      {
        createIntentClient: () => harness.client,
        createScopedPersistence: (scope) => createOfficeScopedLocalStoragePersistence(scope),
        getInitialSnapshot: (scope) => (scope ? readOfficeInitialSnapshot(scope) : null),
        probeReachability: async () => true,
        resolveDocumentScope: async (context, taskpaneSessionId) => {
          if (context.url) {
            return {
              scope: {
                key: 'office-durable:install:doc-saved-no-proof',
                mode: 'durable' as const,
                host: context.host,
                title: context.title,
                settingsId: 'doc-saved-no-proof',
                fingerprint: 'fingerprint-saved',
              },
              sanitizedContext: context,
              reason: 'created-durable' as const,
            };
          }
          return {
            scope: {
              key: `office-ephemeral:install:${taskpaneSessionId}`,
              mode: 'ephemeral' as const,
              host: context.host,
              title: context.title,
              taskpaneSessionId,
            },
            sanitizedContext: context,
            reason: 'unsaved-document' as const,
          };
        },
      },
    );

    await vi.waitFor(() => {
      expect(getTextarea(container).disabled).toBe(false);
    });

    sendComposerMessage(container, 'first draft question');
    await vi.waitFor(() => {
      expect(harness.createConversation).toHaveBeenCalledTimes(1);
    });

    currentContext = {
      host: 'word',
      title: 'Saved Draft.docx',
      url: 'file:///Saved%20Draft.docx',
    };
    chatUI.setDocumentContext(currentContext);

    await vi.waitFor(() => {
      expect(getTextarea(container).disabled).toBe(false);
    });
    sendComposerMessage(container, 'second saved question');

    await vi.waitFor(() => {
      expect(harness.createConversation).toHaveBeenCalledTimes(2);
    });
    expect(infoSpy).toHaveBeenCalledWith(
      '[rebel-addin-scope]',
      expect.objectContaining({
        code: 'scope_migration_skipped',
        migrationResult: 'not-attempted',
        skipReason: 'missing-fingerprint-proof',
      }),
    );
    infoSpy.mockRestore();
  });

  it('keeps the previous Office scope when durable migration writes fail', async () => {
    const harness = createClientHarness();
    const container = document.createElement('div');
    document.body.innerHTML = '';
    document.body.appendChild(container);
    let currentContext: DocumentContext = {
      host: 'word',
      title: 'Draft',
      url: 'file:///Draft.docx',
    };
    const durableScope = {
      key: 'office-durable:install:doc-write-fail',
      mode: 'durable' as const,
      host: 'word',
      title: 'Saved Draft.docx',
      settingsId: 'doc-write-fail',
      fingerprint: 'fingerprint-same',
    };
    const originalSetItem = window.localStorage.setItem.bind(window.localStorage);
    const setItemSpy = vi.spyOn(window.localStorage, 'setItem');

    const chatUI = createChatUI(
      {
        container,
        bridgeConfig: DEFAULT_BRIDGE_CONFIG,
        documentContext: currentContext,
        getDocumentContext: () => currentContext,
      },
      {
        createIntentClient: () => harness.client,
        createScopedPersistence: (scope) => createOfficeScopedLocalStoragePersistence(scope),
        getInitialSnapshot: (scope) => (scope ? readOfficeInitialSnapshot(scope) : null),
        probeReachability: async () => true,
        resolveDocumentScope: async (context, taskpaneSessionId) => {
          if (context.title === 'Saved Draft.docx') {
            return {
              scope: durableScope,
              sanitizedContext: context,
              reason: 'created-durable' as const,
            };
          }
          return {
            scope: {
              key: `office-ephemeral:install:${taskpaneSessionId}`,
              mode: 'ephemeral' as const,
              host: context.host,
              title: context.title,
              taskpaneSessionId,
              fingerprint: 'fingerprint-same',
            },
            sanitizedContext: context,
            reason: 'settings-save-failed' as const,
          };
        },
      },
    );

    await vi.waitFor(() => {
      expect(getTextarea(container).disabled).toBe(false);
    });

    sendComposerMessage(container, 'first draft question');
    await vi.waitFor(() => {
      expect(harness.createConversation).toHaveBeenCalledTimes(1);
    });

    setItemSpy.mockImplementation(function setItemWithDurableFailure(key: string, value: string) {
      if (key.includes(encodeURIComponent(durableScope.key))) {
        throw new Error('quota');
      }
      return originalSetItem(key, value);
    });

    currentContext = {
      host: 'word',
      title: 'Saved Draft.docx',
      url: 'file:///Saved%20Draft.docx',
    };
    chatUI.setDocumentContext(currentContext);

    await vi.waitFor(() => {
      expect(getTextarea(container).disabled).toBe(false);
    });
    sendComposerMessage(container, 'second saved question');

    await vi.waitFor(() => {
      expect(harness.sendMessage).toHaveBeenCalledTimes(1);
    });
    expect(harness.createConversation).toHaveBeenCalledTimes(1);
    setItemSpy.mockRestore();
  });

  it('disables the composer while the shared controller is busy', async () => {
    const createConversationDeferred = deferred<{
      conversationId: string;
      state: 'new';
    }>();
    const harness = createClientHarness();
    harness.createConversation.mockImplementation(async () => await createConversationDeferred.promise);

    const { container } = mountChatUI({ harness });

    sendComposerMessage(container, 'first');

    await vi.waitFor(() => {
      expect(harness.createConversation).toHaveBeenCalledTimes(1);
      expect(getTextarea(container).disabled).toBe(true);
      expect(getSendButton(container).disabled).toBe(true);
    });

    sendComposerMessage(container, 'second');
    expect(harness.createConversation).toHaveBeenCalledTimes(1);

    createConversationDeferred.resolve({ conversationId: 'conv-1', state: 'new' });
  });

  it('renders shared user/assistant/thinking/streaming entries and keeps message text HTML-safe', async () => {
    const now = Date.now();
    const harness = createClientHarness();
    harness.getHistory.mockResolvedValue({
      conversationId: 'conv-1',
      messages: [
        {
          id: 'user-1',
          role: 'user',
          text: 'hello <strong>there</strong>',
          createdAt: now - 5 * 60_000,
        },
        {
          id: 'assistant-1',
          role: 'assistant',
          text: 'reply <script>alert(1)</script>',
          createdAt: now - 60_000,
        },
      ],
      turnStatus: 'running' as const,
    });

    const { container } = mountChatUI({
      harness,
      initialSnapshot: {
        conversationId: 'conv-1',
        pageTitle: 'Quarterly Plan.docx',
        pageUrl: 'file:///Quarterly%20Plan.docx',
      },
    });

    await vi.waitFor(() => {
      expect(harness.connectHandlers).toHaveLength(1);
      expect(container.querySelectorAll('.chat-msg[data-kind="message"]')).toHaveLength(2);
      expect(container.querySelector('.chat-msg[data-kind="thinking"]')).not.toBeNull();
    });

    const userBubble = container.querySelector('.chat-msg-user .chat-bubble');
    expect(userBubble?.textContent).toBe('hello <strong>there</strong>');
    expect((userBubble as HTMLElement | null)?.dataset.relativeTime).toBeTruthy();
    expect((userBubble as HTMLElement | null)?.title).toBeTruthy();

    const assistantBubble = container.querySelector('.chat-msg-assistant .chat-bubble');
    expect(assistantBubble?.textContent).toBe('reply <script>alert(1)</script>');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('strong')).toBeNull();

    harness.connectHandlers[0]?.onEvent({
      type: 'connected',
      conversationId: 'conv-1',
      turnStatus: 'running',
    });
    harness.connectHandlers[0]?.onEvent({ type: 'turn_started', turnId: 'turn-1' });
    harness.connectHandlers[0]?.onEvent({
      type: 'assistant_delta',
      turnId: 'turn-1',
      text: 'Still <em>safe</em>',
    });

    await vi.waitFor(() => {
      const streamingBubble = container.querySelector(
        '.chat-msg.is-streaming .chat-bubble',
      );
      expect(streamingBubble?.textContent).toContain('Still <em>safe</em>');
    });

    expect(container.querySelector('em')).toBeNull();
  });

  it('renders the shared partial-reply indicator when a streamed answer drops mid-response', async () => {
    const harness = createClientHarness();
    const { container } = mountChatUI({
      harness,
      probeReachability: false,
    });

    sendComposerMessage(container, 'hello');

    await vi.waitFor(() => {
      expect(harness.connectHandlers).toHaveLength(1);
    });

    harness.connectHandlers[0]?.onEvent({
      type: 'connected',
      conversationId: 'conv-1',
      turnStatus: 'running',
    });
    harness.connectHandlers[0]?.onEvent({ type: 'turn_started', turnId: 'turn-1' });
    harness.connectHandlers[0]?.onEvent({
      type: 'assistant_delta',
      turnId: 'turn-1',
      text: 'Half a thought',
    });
    harness.connectHandlers[0]?.onError({
      errName: 'TypeError',
      errMsg: 'reader exploded',
      errConstructor: 'TypeError',
      isTypeError: true,
      isDOMException: false,
      isAbortError: false,
    });

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Half a thought');
      expect(
        container.querySelector('.chat-msg-partial')?.textContent,
      ).toContain('Partial reply');
    });
  });

  it('surfaces reconnecting and offline states through the existing header and banner affordances', async () => {
    vi.useFakeTimers();

    const reconnectHarness = createClientHarness();
    reconnectHarness.getHistory.mockResolvedValue({
      conversationId: 'conv-1',
      messages: [{ id: 'm1', role: 'assistant', text: 'Saved', createdAt: 1 }],
      turnStatus: 'running' as const,
    });

    const reconnectUI = mountChatUI({
      harness: reconnectHarness,
      initialSnapshot: {
        conversationId: 'conv-1',
        pageTitle: 'Quarterly Plan.docx',
        pageUrl: 'file:///Quarterly%20Plan.docx',
      },
    });

    await vi.waitFor(() => {
      expect(reconnectHarness.connectHandlers).toHaveLength(1);
    });

    reconnectHarness.connectHandlers[0]?.onClose('error');

    await vi.waitFor(() => {
      expect(getHeader(reconnectUI.container).dataset.status).toBe('reconnecting');
      expect(getConversationBanner(reconnectUI.container).dataset.kind).toBe(
        'reconnecting',
      );
      expect(getConversationBanner(reconnectUI.container).textContent).toBe(
        'Reconnecting to Rebel now.',
      );
    });

    const offlineHarness = createClientHarness();
    offlineHarness.getHistory.mockResolvedValue({
      conversationId: 'conv-1',
      messages: [{ id: 'm1', role: 'assistant', text: 'Saved', createdAt: 1 }],
      turnStatus: 'idle' as const,
    });
    offlineHarness.sendMessage.mockRejectedValueOnce(
      createIntentError('NETWORK_ERROR', 'reader exploded'),
    );

    const offlineUI = mountChatUI({
      harness: offlineHarness,
      probeReachability: false,
      initialSnapshot: {
        conversationId: 'conv-1',
        pageTitle: 'Quarterly Plan.docx',
        pageUrl: 'file:///Quarterly%20Plan.docx',
      },
    });

    await vi.waitFor(() => {
      expect(offlineHarness.connectHandlers).toHaveLength(1);
    });

    sendComposerMessage(offlineUI.container, 'retry me');

    await vi.waitFor(() => {
      expect(getHeader(offlineUI.container).dataset.status).toBe('degraded');
      expect(getConversationBanner(offlineUI.container).dataset.kind).toBe('offline');
      expect(getConversationBanner(offlineUI.container).textContent).toContain(
        "Rebel isn't responding right now. Try again in a moment.",
      );
    });
  });

  it('renders revoked and logical error states with the existing Office copy', async () => {
    const revokedHarness = createClientHarness();
    revokedHarness.getHistory.mockResolvedValue({
      conversationId: 'conv-1',
      messages: [],
      turnStatus: 'idle' as const,
    });

    const revokedUI = mountChatUI({
      harness: revokedHarness,
      initialSnapshot: {
        conversationId: 'conv-1',
        pageTitle: 'Quarterly Plan.docx',
        pageUrl: 'file:///Quarterly%20Plan.docx',
      },
    });

    await vi.waitFor(() => {
      expect(revokedHarness.connectHandlers).toHaveLength(1);
    });

    revokedHarness.connectHandlers[0]?.onEvent({ type: 'revoked' });

    await vi.waitFor(() => {
      expect(getHeader(revokedUI.container).dataset.status).toBe('not-ready');
      expect(revokedUI.container.textContent).toContain('Rebel is setting up');
      expect(getConversationBanner(revokedUI.container).dataset.kind).toBe('revoked');
      expect(getConversationBanner(revokedUI.container).textContent).toContain(
        'Rebel revoked this connection. Open Rebel and re-pair to reconnect.',
      );
    });

    const errorHarness = createClientHarness();
    errorHarness.getHistory.mockResolvedValue({
      conversationId: 'conv-1',
      messages: [],
      turnStatus: 'idle' as const,
    });
    errorHarness.sendMessage.mockRejectedValueOnce(
      createIntentError('BAD_REQUEST', 'That message needs a bit more context.'),
    );

    const errorUI = mountChatUI({
      harness: errorHarness,
      initialSnapshot: {
        conversationId: 'conv-1',
        pageTitle: 'Quarterly Plan.docx',
        pageUrl: 'file:///Quarterly%20Plan.docx',
      },
    });

    await vi.waitFor(() => {
      expect(errorHarness.connectHandlers).toHaveLength(1);
    });

    sendComposerMessage(errorUI.container, 'oops');

    await vi.waitFor(() => {
      expect(getConversationBanner(errorUI.container).dataset.kind).toBe('error');
      expect(getConversationBanner(errorUI.container).textContent).toContain(
        'That message needs a bit more context.',
      );
    });
  });

  it('aborts reset/teardown cleanly through the shared controller lifecycle', async () => {
    const sendDeferred = deferred<{
      conversationId: string;
      messageId: string;
      state: 'submitted';
      queueSize: number;
    }>();
    let observedSignal: AbortSignal | null = null;
    const harness = createClientHarness();
    harness.getHistory.mockResolvedValue({
      conversationId: 'conv-1',
      messages: [],
      turnStatus: 'idle' as const,
    });
    harness.sendMessage.mockImplementation(async (_input, signal) => {
      observedSignal = signal;
      return await sendDeferred.promise;
    });

    const { chatUI, container } = mountChatUI({
      harness,
      initialSnapshot: {
        conversationId: 'conv-1',
        pageTitle: 'Quarterly Plan.docx',
        pageUrl: 'file:///Quarterly%20Plan.docx',
      },
    });

    await vi.waitFor(() => {
      expect(harness.connectHandlers).toHaveLength(1);
    });

    sendComposerMessage(container, 'abort me');

    await vi.waitFor(() => {
      expect(harness.sendMessage).toHaveBeenCalledTimes(1);
      expect(observedSignal).not.toBeNull();
    });

    getStartFreshButton(container).click();

    await vi.waitFor(() => {
      expect(observedSignal?.aborted).toBe(true);
      expect(container.textContent).toContain('What can I help you with?');
    });

    sendDeferred.resolve({
      conversationId: 'conv-1',
      messageId: 'msg-1',
      state: 'submitted',
      queueSize: 0,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(container.textContent).not.toContain('abort me');

    const disposeHarness = createClientHarness();
    disposeHarness.getHistory.mockResolvedValue({
      conversationId: 'conv-1',
      messages: [],
      turnStatus: 'running' as const,
    });
    const disposeUI = mountChatUI({
      harness: disposeHarness,
      initialSnapshot: {
        conversationId: 'conv-1',
        pageTitle: 'Quarterly Plan.docx',
        pageUrl: 'file:///Quarterly%20Plan.docx',
      },
    });

    await vi.waitFor(() => {
      expect(disposeHarness.connectHandlers).toHaveLength(1);
    });

    disposeUI.chatUI.dispose();
    expect(disposeHarness.streamClose).toHaveBeenCalled();
  });

  it('keeps the Office add-in free of React imports and dependencies', () => {
    const packageJson = JSON.parse(
      readFileSync(join(packageRoot, 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(packageJson.dependencies?.react).toBeUndefined();
    expect(packageJson.dependencies?.['react-dom']).toBeUndefined();
    expect(packageJson.devDependencies?.react).toBeUndefined();
    expect(packageJson.devDependencies?.['react-dom']).toBeUndefined();

    const sourceFiles = collectSourceFiles(join(packageRoot, 'src', 'addin'));
    for (const filePath of sourceFiles) {
      const content = readFileSync(filePath, 'utf8');
      expect(content).not.toMatch(/from ['"]react['"]/);
      expect(content).not.toMatch(/from ['"]react-dom['"]/);
      expect(content.includes('react-dom/client')).toBe(false);
    }
  });
});

describe('office document scope helpers (Stage 1)', () => {
  function createSettings(
    initial: Record<string, unknown> = {},
    status: 'succeeded' | 'failed' = 'succeeded',
  ) {
    const store = new Map<string, unknown>(Object.entries(initial));
    return {
      store,
      settings: {
        get(name: string) {
          return store.get(name);
        },
        set(name: string, value: unknown) {
          store.set(name, value);
        },
        saveAsync(callback: (result: { status: string }) => void) {
          callback({ status });
        },
      },
    };
  }

  it('resolves a durable scope for saved Office documents and stores an opaque settings id', async () => {
    const { settings, store } = createSettings();

    const resolved = await resolveOfficeDocumentScope({
      documentContext: DEFAULT_DOCUMENT_CONTEXT,
      taskpaneSessionId: 'taskpane-1',
      settings,
      createOpaqueId: () => 'doc-scope-1',
      storage: window.localStorage,
    });

    expect(resolved.scope.mode).toBe('durable');
    expect(resolved.scope.settingsId).toBe('doc-scope-1');
    expect(store.get('rebel.documentScopeId')).toBe('doc-scope-1');
    expect(resolved.reason).toBe('created-durable');
  });

  it('restores an existing durable settings id even when Office does not expose a URL', async () => {
    const { settings } = createSettings({
      'rebel.documentScopeId': 'doc-scope-existing',
    });

    const resolved = await resolveOfficeDocumentScope({
      documentContext: {
        host: 'word',
        title: 'Untitled document',
      },
      taskpaneSessionId: 'taskpane-existing',
      settings,
      createOpaqueId: () => 'unused-new-id',
      storage: window.localStorage,
    });

    expect(resolved.scope.mode).toBe('durable');
    expect(resolved.scope.settingsId).toBe('doc-scope-existing');
    expect(resolved.reason).toBe('resolved-durable');
  });

  it('falls back to an ephemeral scope for unsaved documents', async () => {
    const resolved = await resolveOfficeDocumentScope({
      documentContext: {
        host: 'word',
        title: 'Draft',
      },
      taskpaneSessionId: 'taskpane-2',
      settings: createSettings().settings,
      createOpaqueId: () => 'unused',
      storage: window.localStorage,
    });

    expect(resolved.scope.mode).toBe('ephemeral');
    expect(resolved.reason).toBe('unsaved-document');
  });

  it('forks a copied document when the stored fingerprint diverges', async () => {
    const { settings, store } = createSettings({
      'rebel.documentScopeId': 'doc-scope-old',
    });
    window.localStorage.setItem(
      'rebel.office.documentFingerprint.v1.doc-scope-old',
      JSON.stringify({ fingerprint: 'old-fingerprint' }),
    );

    const resolved = await resolveOfficeDocumentScope({
      documentContext: {
        host: 'word',
        title: 'Copy.docx',
        url: 'file:///Copy.docx',
      },
      taskpaneSessionId: 'taskpane-3',
      settings,
      createOpaqueId: () => 'doc-scope-new',
      storage: window.localStorage,
    });

    expect(resolved.reason).toBe('copy-diverged');
    expect(resolved.scope.mode).toBe('durable');
    expect(resolved.scope.settingsId).toBe('doc-scope-new');
    expect(store.get('rebel.documentScopeId')).toBe('doc-scope-new');
  });

  it('forks a saved document when local fingerprint proof is missing', async () => {
    const { settings, store } = createSettings({
      'rebel.documentScopeId': 'doc-scope-existing',
    });

    const resolved = await resolveOfficeDocumentScope({
      documentContext: {
        host: 'word',
        title: 'Recovered.docx',
        url: 'file:///Recovered.docx',
      },
      taskpaneSessionId: 'taskpane-missing-proof',
      settings,
      createOpaqueId: () => 'doc-scope-recovered',
      storage: window.localStorage,
    });

    expect(resolved.reason).toBe('copy-diverged');
    expect(resolved.scope.settingsId).toBe('doc-scope-recovered');
    expect(store.get('rebel.documentScopeId')).toBe('doc-scope-recovered');
  });

  it('falls back cleanly when localStorage access throws', async () => {
    const throwingStorage = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
      removeItem() {
        throw new Error('blocked');
      },
      clear() {},
      key() {
        return null;
      },
      length: 0,
    } satisfies Storage;

    await expect(resolveOfficeDocumentScope({
      documentContext: {
        host: 'word',
        title: 'Draft',
      },
      taskpaneSessionId: 'taskpane-storage-blocked',
      settings: createSettings().settings,
      createOpaqueId: () => 'unused',
      storage: throwingStorage,
    })).resolves.toMatchObject({
      reason: 'unsaved-document',
      scope: { mode: 'ephemeral' },
    });
  });

  it('aliases an ephemeral chat record into a durable scope after save', async () => {
    const ephemeralScope = {
      key: 'office-ephemeral:install:taskpane-4',
      mode: 'ephemeral' as const,
      host: 'word',
    };
    const durableScope = {
      key: 'office-durable:install:doc-scope-4',
      mode: 'durable' as const,
      host: 'word',
      settingsId: 'doc-scope-4',
      fingerprint: 'fingerprint-4',
    };
    const ephemeralPersistence = createOfficeScopedLocalStoragePersistence(ephemeralScope);
    await ephemeralPersistence.set({
      conversationId: 'conv-office',
      pageTitle: 'Draft.docx',
    });

    expect(copyChatStateBetweenScopes(ephemeralScope, durableScope, window.localStorage)).toBe(true);

    const durablePersistence = createOfficeScopedLocalStoragePersistence(durableScope);
    await expect(durablePersistence.get()).resolves.toMatchObject({
      conversationId: 'conv-office',
      pageTitle: 'Draft.docx',
    });
  });

  it('sanitizes saved document urls and stores only an opaque scope id in document settings', async () => {
    const { settings, store } = createSettings();

    const resolved = await resolveOfficeDocumentScope({
      documentContext: {
        host: 'word',
        title: 'Quarterly Plan.docx',
        url: 'https://tenant.sharepoint.com/sites/rebel/Quarterly%20Plan.docx?download=1#section-2',
      },
      taskpaneSessionId: 'taskpane-privacy',
      settings,
      createOpaqueId: () => 'doc-scope-private',
      storage: window.localStorage,
    });

    expect(resolved.scope.mode).toBe('durable');
    expect(resolved.sanitizedContext.url).toBe(
      'https://tenant.sharepoint.com/sites/rebel/Quarterly%20Plan.docx',
    );
    expect(Array.from(store.entries())).toEqual([
      ['rebel.documentScopeId', 'doc-scope-private'],
    ]);
  });
});

describe('office document context provider (Stage 1)', () => {
  it('captures document context without synthesizing a browser tab id', () => {
    const provider = createOfficeDocumentContextProvider({
      host: 'word',
      title: 'Quarterly Plan.docx',
      url: 'file:///Quarterly%20Plan.docx',
    });

    expect(provider.captureContext()).toEqual({
      documentContext: {
        host: 'word',
        title: 'Quarterly Plan.docx',
      },
      pageContext: {
        title: 'Quarterly Plan.docx',
      },
    });
    expect(provider.captureContext()).not.toHaveProperty('tabContext');
  });
});
