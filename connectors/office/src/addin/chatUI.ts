/**
 * Office task pane chat UI (Stage 10 of
 * `260424_shared_embedded_chat_stack_unification.md`).
 *
 * Plain-DOM chat surface mirroring the browser extension's React side
 * panel (`packages/browser-extension/src/sidepanel/SidePanel.tsx`). The
 * Office add-in uses vanilla TS + DOM — no React — so this module takes
 * a container element and owns all rendering + event wiring imperatively.
 *
 * The UI reuses the CSS variables defined in `taskpane.html` so dark and
 * light mode follow `prefers-color-scheme` automatically.
 *
 * @see docs/plans/260424_shared_embedded_chat_stack_unification.md
 */

import { createChatController } from '../shared/chatController/controller.js';
import type {
  ChatController as SharedChatController,
  ChatControllerError as SharedChatControllerError,
  ChatControllerSnapshot,
  ChatStatePersistence,
} from '../shared/chatController/types.js';
import {
  buildConversationEntries,
  buildConversationNotice,
  buildContextChipViewModel,
  normalizeText,
  resolveHeaderStatus,
  type ContextChipViewModel,
  type ConversationEntryViewModel,
  type ConversationNoticeViewModel,
  type SharedConnectionHealth,
  type SharedHeaderStatus,
} from '../shared/chatUI/index.js';
import type {
  ConnectStreamError,
  ConnectStreamHandlers,
  IntentClient,
  IntentClientError,
} from '../shared/intentClient/index.js';
import {
  connectStream,
  createConversation,
  focusInRebel,
  getHistory,
  probeReachability,
  sendMessage,
  type BridgeConfig,
  type ChatErrorCode,
  type DocumentContext,
  type HistoryMessage,
  type StreamEvent,
} from './chatClient.js';
import {
  copyChatStateBetweenScopesWithResult,
  createOfficeScopedLocalStoragePersistence,
  getInitialSnapshot as readInitialSnapshot,
} from './chatState.js';
import {
  createOfficeDocumentContextProvider,
  type OfficeDocumentContextProvider,
} from './documentContextProvider.js';
import {
  createOfficeTaskpaneSessionId,
  hashOfficeScopeKey,
  resolveOfficeDocumentScope,
  type OfficeDocumentScope,
  type OfficeDocumentScopeResolution,
} from './documentScope.js';

export type ChatPhase = 'not-ready' | 'idle' | 'chatting';

/**
 * Live health of the chat bridge, independent of the conversation phase.
 * Drives the header dot so the pill never contradicts a visible error
 * banner — e.g. we don't want the dot to say "connected" while the body
 * explains that Rebel isn't reachable.
 */
export type ConnectionHealth = SharedConnectionHealth;

const CONNECTIVITY_ERROR_CODES: ReadonlySet<ChatErrorCode> = new Set<ChatErrorCode>([
  'APP_NOT_CONNECTED',
  'PORT_UNREACHABLE',
  'NETWORK_ERROR',
  'TIMEOUT',
]);

const EMPTY_CONTROLLER_SNAPSHOT: ChatControllerSnapshot = {
  phase: 'hydrating',
  conversationId: null,
  conversationContext: {},
  messages: [],
  turnStatus: 'idle',
  error: null,
  retryableSend: null,
  creatingConversation: false,
  reconnectAttempt: 0,
};
const EMPTY_STREAMING_TEXT = '';
const NOT_READY_COPY =
  "Rebel's browser connection isn't paired yet. Open the Rebel desktop app, finish setup, and this panel will wake up.";
const SETTING_UP_COPY = 'Rebel is still setting up. Try again in a moment.';
const REVOKED_COPY =
  'Rebel revoked this connection. Open Rebel and re-pair to reconnect.';
const STREAM_DROPPED_COPY =
  "Rebel's streaming connection dropped. Your next message will try to reconnect.";
const MISSING_CONTEXT_COPY = 'Open a document, then try again.';

type InitialSnapshot = ReturnType<typeof readInitialSnapshot>;

interface ConversationContext {
  pageTitle?: string;
  pageUrl?: string;
}

interface ChatUIViewState {
  phase: ChatPhase;
  conversationId: string | null;
  conversationContext: ConversationContext;
  messages: HistoryMessage[];
  streamingText: string;
  turnStatus: 'idle' | 'running';
  conversationNotice: ConversationNoticeViewModel | null;
  creatingConversation: boolean;
  connectionHealth: ConnectionHealth;
}

export interface ChatUIOptions {
  /** Root container for the chat UI (provided by taskpane.html). */
  container: HTMLElement;
  /** Bridge connection config (injected by the sidecar). Null when not ready. */
  bridgeConfig: BridgeConfig | null;
  /** Current document context — rendered in the chip + attached to new conversations. */
  documentContext?: DocumentContext;
  /** Re-captures host document context before sends/focus-driven refreshes. */
  getDocumentContext?: () => DocumentContext;
}

export interface ChatController {
  /**
   * Update the bridge config once the sidecar finishes pairing with the
   * App Bridge (or when pairing is revoked). Passing null drops the pane
   * back to the `not-ready` state.
   */
  setBridgeConfig(config: BridgeConfig | null): void;
  /** Update document context (e.g. when a Word doc loads). */
  setDocumentContext(context: DocumentContext): void;
  /** Tear down timers / stream on dispose (e.g. add-in close). */
  dispose(): void;
}

interface ChatUIDependencies {
  createController(options: Parameters<typeof createChatController>[0]): SharedChatController;
  createIntentClient(options: {
    getBridgeConfig: () => BridgeConfig | null;
    contextProvider: OfficeDocumentContextProvider;
  }): IntentClient;
  getInitialSnapshot(scope?: OfficeDocumentScope): InitialSnapshot;
  persistence?: ChatStatePersistence;
  createScopedPersistence?(scope: OfficeDocumentScope): ChatStatePersistence;
  probeReachability(config: BridgeConfig | null): Promise<boolean>;
  resolveDocumentScope?(
    context: DocumentContext,
    taskpaneSessionId: string,
  ): Promise<OfficeDocumentScopeResolution>;
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

function mapLegacyErrorCode(code: ChatErrorCode): IntentClientError['code'] {
  switch (code) {
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

function toIntentError(result: {
  ok: false;
  error: ChatErrorCode;
  message: string;
  status?: number;
}): IntentClientError {
  return createIntentError(
    mapLegacyErrorCode(result.error),
    result.message,
    result.status,
  );
}

function toConnectStreamError(error: unknown): ConnectStreamError {
  const maybeIntentError = error as IntentClientError | null;
  if (maybeIntentError && typeof maybeIntentError.code === 'string') {
    return {
      code: maybeIntentError.code,
      message: maybeIntentError.message,
      ...(typeof maybeIntentError.status === 'number'
        ? { status: maybeIntentError.status }
        : {}),
    };
  }

  if (error instanceof Error) {
    const [rawCode, ...rest] = error.message.split(':');
    const trimmedCode = rawCode?.trim();
    if (isLegacyChatErrorCode(trimmedCode)) {
      return {
        code: mapLegacyErrorCode(trimmedCode),
        message: rest.join(':').trim() || error.message,
      };
    }
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    errName: error instanceof Error ? error.name : 'Error',
    errMsg: message,
    errConstructor:
      error instanceof Error ? error.constructor.name : typeof error,
    isTypeError: error instanceof TypeError,
    isDOMException:
      typeof DOMException !== 'undefined' && error instanceof DOMException,
    isAbortError: false,
  };
}

function isLegacyChatErrorCode(value: string | undefined): value is ChatErrorCode {
  switch (value) {
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
      return true;
    default:
      return false;
  }
}

function createOfficeIntentClient(options: {
  getBridgeConfig: () => BridgeConfig | null;
  contextProvider: OfficeDocumentContextProvider;
}): IntentClient {
  const requireBridgeConfig = (): BridgeConfig => {
    const config = options.getBridgeConfig();
    if (!config) {
      throw createIntentError('APP_NOT_CONNECTED', SETTING_UP_COPY);
    }
    return config;
  };

  return {
    async createConversation(input, signal) {
      const config = requireBridgeConfig();
      const capturedContext = options.contextProvider.captureContext();
      const documentContext = capturedContext.documentContext;
      const pageContext = {
        ...(input.pageContext?.title ?? capturedContext.pageContext?.title ?? documentContext?.title
          ? { title: input.pageContext?.title ?? capturedContext.pageContext?.title ?? documentContext?.title }
          : {}),
        ...(input.pageContext?.url ?? capturedContext.pageContext?.url
          ? { url: input.pageContext?.url ?? capturedContext.pageContext?.url }
          : {}),
      };

      const result = await createConversation({
        ...config,
        intent: input.intent,
        userText: input.userText ?? '',
        ...(input.switchToConversation !== undefined
          ? { switchToConversation: input.switchToConversation }
          : {}),
        ...(documentContext ? { documentContext } : {}),
        ...(Object.keys(pageContext).length > 0 ? { pageContext } : {}),
        ...(input.title ? { title: input.title } : {}),
        ...(signal ? { signal } : {}),
      });

      if (!result.ok) {
        throw toIntentError(result);
      }

      return {
        conversationId: result.conversationId,
        ...(result.state ? { state: result.state } : {}),
      };
    },

    async sendMessage(input, signal) {
      const config = requireBridgeConfig();
      const documentContext = options.contextProvider.captureContext().documentContext;
      const result = await sendMessage({
        ...config,
        conversationId: input.conversationId,
        text: input.text,
        ...(documentContext ? { documentContext } : {}),
        ...(signal ? { signal } : {}),
      });

      if (!result.ok) {
        throw toIntentError(result);
      }

      return {
        conversationId: input.conversationId,
        messageId: result.messageId,
        state: result.state,
        queueSize: result.queueSize,
      };
    },

    async getHistory(input, signal) {
      const config = requireBridgeConfig();
      const result = await getHistory({
        ...config,
        conversationId: input.conversationId,
        ...(signal ? { signal } : {}),
      });

      if (!result.ok) {
        throw toIntentError(result);
      }

      return {
        conversationId: input.conversationId,
        messages: result.messages,
        turnStatus: result.turnStatus,
        ...(result.conversationTitle
          ? { conversationTitle: result.conversationTitle }
          : {}),
      };
    },

    async focusInRebel(input, signal) {
      const config = requireBridgeConfig();
      const result = await focusInRebel({
        ...config,
        conversationId: input.conversationId,
        ...(signal ? { signal } : {}),
      });

      if (!result.ok) {
        throw toIntentError(result);
      }

      return {
        conversationId: input.conversationId,
        focused: true,
      };
    },

    connectStream(input, handlers: ConnectStreamHandlers) {
      let closed = false;
      let connection: { close(): void } | null = null;
      let closeNotified = false;

      const notifyClose = (reason: 'eof' | 'aborted' | 'error' | 'revoked'): void => {
        if (closeNotified) return;
        closeNotified = true;
        handlers.onClose(reason);
      };

      const close = (): void => {
        if (closed) return;
        closed = true;
        connection?.close();
        if (!connection) {
          notifyClose('aborted');
        }
      };

      void Promise.resolve()
        .then(() => {
          const config = requireBridgeConfig();
          if (closed) return;
          connection = connectStream({
            ...config,
            conversationId: input.conversationId,
            ...(input.signal ? { signal: input.signal } : {}),
            onEvent: (event) => {
              if (closed) return;
              handlers.onEvent(event);
            },
            onError: (error) => {
              if (closed) return;
              handlers.onError(toConnectStreamError(error));
            },
            onClose: (reason) => {
              if (closed && reason === undefined) {
                notifyClose('aborted');
                return;
              }
              notifyClose(reason ?? 'eof');
            },
          });
        })
        .catch((error) => {
          if (closed) return;
          handlers.onError(toConnectStreamError(error));
          notifyClose('error');
        });

      return { close };
    },
  };
}

const defaultChatUIDependencies: ChatUIDependencies = {
  createController: createChatController,
  createIntentClient: createOfficeIntentClient,
  getInitialSnapshot: (scope) => (scope ? readInitialSnapshot(scope) : null),
  createScopedPersistence: (scope) => createOfficeScopedLocalStoragePersistence(scope),
  async probeReachability(config: BridgeConfig | null): Promise<boolean> {
    if (!config) return false;
    return probeReachability(config);
  },
  async resolveDocumentScope(
    context: DocumentContext,
    taskpaneSessionId: string,
  ): Promise<OfficeDocumentScopeResolution> {
    return await resolveOfficeDocumentScope({
      documentContext: context,
      taskpaneSessionId,
      settings: Office?.context?.document?.settings as
        | {
            get(name: string): unknown;
            set(name: string, value: unknown): void;
            saveAsync(
              callback: (result: { status: string; error?: { name?: string; message?: string } }) => void,
            ): void;
          }
        | undefined,
      log: (entry) => {
        const emit =
          entry.code === 'scope_fallback_ephemeral' || entry.code === 'scope_mismatch_discarded'
            ? console.warn
            : console.info;
        emit('[rebel-addin-scope]', entry);
      },
    });
  },
};

/**
 * Bootstrap the chat UI inside `options.container`. Returns a controller
 * so the taskpane entry script can update config dynamically and dispose
 * on teardown.
 */
export function createChatUI(
  options: ChatUIOptions,
  dependencies: Partial<ChatUIDependencies> = {},
): ChatController {
  const deps: ChatUIDependencies = {
    ...defaultChatUIDependencies,
    ...dependencies,
  };
  let bridgeConfig = options.bridgeConfig;
  const documentContextProvider = createOfficeDocumentContextProvider(
    options.documentContext,
  );
  const container = options.container;

  let controller: SharedChatController | null = null;
  let controllerSnapshot: ChatControllerSnapshot = { ...EMPTY_CONTROLLER_SNAPSHOT };
  let controllerStreamingText = EMPTY_STREAMING_TEXT;
  let initialSnapshot = bridgeConfig && deps.persistence ? deps.getInitialSnapshot() : null;
  let unsubscribeState: (() => void) | null = null;
  let unsubscribeStreaming: (() => void) | null = null;
  let disposed = false;
  let documentScope: OfficeDocumentScope | null = null;
  const taskpaneSessionId = createOfficeTaskpaneSessionId();
  let scopeReady = Boolean(deps.persistence);
  let scopeResolutionGeneration = 0;

  container.replaceChildren();
  container.classList.add('chat');

  const headerEl = createHeader({
    onStartFresh: () => {
      void handleStartFresh();
    },
    onOpenInRebel: () => {
      void handleOpenInRebel();
    },
  });
  const bodyEl = document.createElement('div');
  bodyEl.className = 'chat-body';
  bodyEl.setAttribute('role', 'log');
  bodyEl.setAttribute('aria-live', 'polite');

  const composerEl = createComposer({
    onSend: (text) => {
      void handleSend(text);
    },
  });

  container.appendChild(headerEl.root);
  container.appendChild(bodyEl);
  container.appendChild(composerEl.root);

  if (bridgeConfig && deps.persistence) {
    mountController();
  } else if (bridgeConfig) {
    void ensureDocumentScope('mount');
  }
  render();

  return {
    setBridgeConfig(next: BridgeConfig | null): void {
      if (disposed) return;
      void refreshDocumentContextFromHost();
      const changed =
        bridgeConfig?.sidecarToken !== next?.sidecarToken ||
        bridgeConfig?.originBase !== next?.originBase;
      bridgeConfig = next;

      if (!next) {
        unmountController();
        controllerSnapshot = { ...EMPTY_CONTROLLER_SNAPSHOT };
        controllerStreamingText = EMPTY_STREAMING_TEXT;
        initialSnapshot = null;
        documentScope = null;
        scopeReady = Boolean(deps.persistence);
        render();
        return;
      }

      if (deps.persistence) {
        if (!controller || changed || controllerSnapshot.phase === 'revoked') {
          mountController();
        }
      } else {
        scopeReady = false;
        void ensureDocumentScope('mount');
      }
      render();
    },

    setDocumentContext(next: DocumentContext): void {
      documentContextProvider.setDocumentContext(next);
      scopeResolutionGeneration += 1;
      if (!deps.persistence && bridgeConfig) {
        scopeReady = false;
        void ensureDocumentScope('mount');
        return;
      }
      if (!hasRenderableConversation(controllerSnapshot, initialSnapshot)) {
        render();
      }
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      unmountController();
    },
  };

  function mountController(): void {
    if (!bridgeConfig || disposed) return;
    if (!deps.persistence && !documentScope) return;

    unmountController();
    const persistence = deps.persistence ?? deps.createScopedPersistence?.(documentScope!);
    if (!persistence) {
      return;
    }
    initialSnapshot = deps.getInitialSnapshot(documentScope ?? undefined);

    const nextController = deps.createController({
      client: deps.createIntentClient({
        getBridgeConfig: () => bridgeConfig,
        contextProvider: documentContextProvider,
      }),
      persistence,
      transport: {
        probeReachability: async () => await deps.probeReachability(bridgeConfig),
      },
      context: documentContextProvider,
      missingContextMessage: MISSING_CONTEXT_COPY,
    });

    controller = nextController;
    controllerSnapshot = nextController.getSnapshot();
    controllerStreamingText = nextController.getStreamingText();

    unsubscribeState = nextController.subscribe(() => {
      if (controller !== nextController) return;
      controllerSnapshot = nextController.getSnapshot();
      if (controllerSnapshot.phase !== 'hydrating') {
        initialSnapshot = null;
      }
      render();
    });

    unsubscribeStreaming = nextController.subscribeStreamingText(() => {
      if (controller !== nextController) return;
      controllerStreamingText = nextController.getStreamingText();
      render();
    });
  }

  function unmountController(): void {
    unsubscribeState?.();
    unsubscribeState = null;
    unsubscribeStreaming?.();
    unsubscribeStreaming = null;
    controller?.dispose();
    controller = null;
  }

  async function ensureDocumentScope(trigger: 'mount' | 'send'): Promise<void> {
    if (deps.persistence || !deps.resolveDocumentScope || !bridgeConfig || disposed) {
      return;
    }

    const generation = ++scopeResolutionGeneration;
    const resolved = await deps.resolveDocumentScope(
      documentContextProvider.getDocumentContext(),
      taskpaneSessionId,
    );
    if (disposed || generation !== scopeResolutionGeneration) return;

    const previousScope = documentScope;
    documentContextProvider.setDocumentContext(resolved.sanitizedContext);

    const migrationEligibility = getEphemeralScopeMigrationEligibility(
      previousScope,
      resolved.scope,
      taskpaneSessionId,
    );
    if (migrationEligibility.shouldMigrate) {
      const migrationResult = copyChatStateBetweenScopesWithResult(previousScope!, resolved.scope);
      emitScopeMigrationResult(previousScope!, resolved.scope, resolved.reason, migrationResult);
      if (migrationResult === 'write-failed') {
        documentScope = previousScope!;
        scopeReady = true;
        mountAfterScopeResolution(previousScope, previousScope!, trigger);
        return;
      }
    } else if (migrationEligibility.skipReason) {
      emitScopeMigrationResult(
        previousScope!,
        resolved.scope,
        resolved.reason,
        'not-attempted',
        migrationEligibility.skipReason,
      );
    }

    documentScope = resolved.scope;
    scopeReady = true;
    mountAfterScopeResolution(previousScope, resolved.scope, trigger);
  }

  function mountAfterScopeResolution(
    previousScope: OfficeDocumentScope | null,
    nextScope: OfficeDocumentScope,
    trigger: 'mount' | 'send',
  ): void {
    if (!controller || previousScope?.key !== nextScope.key) {
      mountController();
      render();
      return;
    }

    if (!hasRenderableConversation(controllerSnapshot, initialSnapshot)) {
      render();
    }
  }

  function getViewState(): ChatUIViewState {
    const phase = derivePhase(bridgeConfig, controllerSnapshot, initialSnapshot);
    const conversationId =
      controllerSnapshot.conversationId ??
      (controllerSnapshot.phase === 'hydrating'
        ? initialSnapshot?.conversationId ?? null
        : null);

    return {
      phase,
      conversationId,
      conversationContext:
        controllerSnapshot.conversationId || controllerSnapshot.phase !== 'hydrating'
          ? controllerSnapshot.conversationContext
          : {
              ...(initialSnapshot?.pageTitle
                ? { pageTitle: initialSnapshot.pageTitle }
                : {}),
              ...(initialSnapshot?.pageUrl
                ? { pageUrl: initialSnapshot.pageUrl }
                : {}),
            },
      messages: controllerSnapshot.messages,
      streamingText: controllerStreamingText,
      turnStatus: controllerSnapshot.turnStatus,
      conversationNotice: deriveConversationNotice(controllerSnapshot),
      creatingConversation: controllerSnapshot.creatingConversation,
      connectionHealth: deriveConnectionHealth(controllerSnapshot),
    };
  }

  function render(): void {
    const view = getViewState();

    headerEl.setStatus(computeHeaderStatus(view.phase, view.connectionHealth));
    headerEl.setHasConversation(view.conversationId !== null);

    bodyEl.replaceChildren();

    if (view.phase === 'not-ready') {
      bodyEl.appendChild(createNotReadyPanel());
    } else if (!hasRenderableConversation(controllerSnapshot, initialSnapshot)) {
      bodyEl.appendChild(
        createEmptyStatePanel(documentContextProvider.captureContext().documentContext ?? {}),
      );
    } else {
      const contextChip = buildConversationContextChip(view.conversationContext);
      if (contextChip) {
        bodyEl.appendChild(createContextChip(contextChip));
      }
      bodyEl.appendChild(
        renderMessageList(view.messages, view.streamingText, view.turnStatus),
      );
    }

    if (view.conversationNotice) {
      bodyEl.appendChild(
        createErrorBanner(
          messageForConversationNotice(view.conversationNotice),
          view.conversationNotice.kind,
        ),
      );
    }

    const composerDisabled =
      view.phase === 'not-ready' ||
      !scopeReady ||
      !controller ||
      controllerSnapshot.phase === 'sending' ||
      controllerSnapshot.phase === 'streaming' ||
      controllerSnapshot.phase === 'reconnecting' ||
      view.creatingConversation;
    const placeholder =
      view.phase === 'not-ready'
        ? 'Rebel is setting up — hang tight'
        : view.conversationId
          ? 'Message Rebel…'
          : 'Ask about this document…';

    composerEl.setDisabled(composerDisabled);
    composerEl.setPlaceholder(placeholder);

    queueMicrotask(() => {
      bodyEl.scrollTop = bodyEl.scrollHeight;
    });
  }

  async function handleSend(rawText: string): Promise<void> {
    const text = rawText.trim();
    if (!text) return;
    if (!refreshDocumentContextFromHost()) {
      render();
      return;
    }
    if (!deps.persistence) {
      await ensureDocumentScope('send');
    }
    if (!controller) {
      render();
      return;
    }

    try {
      await controller.send(text);
    } catch (error) {
      const maybeControllerError = error as SharedChatControllerError | null;
      if (maybeControllerError?.code === 'BUSY') {
        return;
      }
      render();
    }
  }

  async function handleStartFresh(): Promise<void> {
    initialSnapshot = null;
    await controller?.startFresh();
    render();
  }

  async function handleOpenInRebel(): Promise<void> {
    await controller?.openInRebel();
  }

  function refreshDocumentContextFromHost(): boolean {
    if (!options.getDocumentContext || disposed) return true;
    try {
      documentContextProvider.setDocumentContext(options.getDocumentContext());
      return true;
    } catch (error) {
      scopeReady = false;
      console.warn('[rebel-addin-scope]', {
        code: 'scope_context_refresh_failed',
        surface: 'office-addin',
        errorName: error instanceof Error ? error.name : 'Error',
      });
      return false;
    }
  }
}

type ScopeMigrationEligibility =
  | { shouldMigrate: true }
  | { shouldMigrate: false; skipReason?: 'fingerprint-mismatch' | 'missing-fingerprint-proof' };

function getEphemeralScopeMigrationEligibility(
  previousScope: OfficeDocumentScope | null,
  nextScope: OfficeDocumentScope,
  taskpaneSessionId: string,
): ScopeMigrationEligibility {
  if (!previousScope) return { shouldMigrate: false };
  if (previousScope.key === nextScope.key) return { shouldMigrate: false };
  if (previousScope.mode !== 'ephemeral' || nextScope.mode !== 'durable') {
    return { shouldMigrate: false };
  }
  if (previousScope.taskpaneSessionId !== taskpaneSessionId) {
    return { shouldMigrate: false };
  }
  if (previousScope.fingerprint && nextScope.fingerprint) {
    return previousScope.fingerprint === nextScope.fingerprint
      ? { shouldMigrate: true }
      : { shouldMigrate: false, skipReason: 'fingerprint-mismatch' };
  }
  return { shouldMigrate: false, skipReason: 'missing-fingerprint-proof' };
}

function emitScopeMigrationResult(
  previousScope: OfficeDocumentScope,
  nextScope: OfficeDocumentScope,
  reason: OfficeDocumentScopeResolution['reason'],
  migrationResult: 'copied' | 'missing-source' | 'target-exists' | 'write-failed' | 'not-attempted',
  skipReason?: string,
): void {
  const migrated = migrationResult === 'copied';
  const failed = migrationResult === 'write-failed';
  const emit = failed ? console.warn : console.info;
  emit('[rebel-addin-scope]', {
    code: migrated
      ? 'scope_migrated'
      : failed
        ? 'scope_migration_failed'
        : 'scope_migration_skipped',
    surface: 'office-addin',
    fromScopeMode: previousScope.mode,
    toScopeMode: nextScope.mode,
    fromScopeKeyHash: hashOfficeScopeKey(previousScope.key),
    toScopeKeyHash: hashOfficeScopeKey(nextScope.key),
    reason,
    migrationResult,
    ...(skipReason ? { skipReason } : {}),
  });
}

function hasRenderableConversation(
  snapshot: ChatControllerSnapshot,
  initialSnapshot: InitialSnapshot,
): boolean {
  return Boolean(
    snapshot.conversationId ||
      initialSnapshot?.conversationId ||
      snapshot.messages.length > 0 ||
      snapshot.phase === 'sending' ||
      snapshot.phase === 'streaming',
  );
}

function derivePhase(
  bridgeConfig: BridgeConfig | null,
  snapshot: ChatControllerSnapshot,
  initialSnapshot: InitialSnapshot,
): ChatPhase {
  if (!bridgeConfig || snapshot.phase === 'revoked') {
    return 'not-ready';
  }
  if (hasRenderableConversation(snapshot, initialSnapshot)) {
    return 'chatting';
  }
  return 'idle';
}

function deriveConnectionHealth(
  snapshot: ChatControllerSnapshot,
): ConnectionHealth {
  if (snapshot.phase === 'reconnecting') {
    return 'reconnecting';
  }
  if (snapshot.phase === 'offline' || snapshot.phase === 'revoked') {
    return 'degraded';
  }
  if (snapshot.error && isConnectivityControllerError(snapshot.error)) {
    return 'degraded';
  }
  return 'healthy';
}

function isConnectivityControllerError(
  error: SharedChatControllerError,
): boolean {
  return isLegacyChatErrorCode(error.code)
    ? CONNECTIVITY_ERROR_CODES.has(error.code)
    : false;
}

function deriveConversationNotice(
  snapshot: ChatControllerSnapshot,
): ConversationNoticeViewModel | null {
  return buildConversationNotice({
    phase: snapshot.phase,
    errorMessage: snapshot.error
      ? friendlyError(snapshot.error.code, snapshot.error.message)
      : null,
  });
}

// ---------------------------------------------------------------------------
// Sub-views — plain DOM builders
// ---------------------------------------------------------------------------

export type HeaderStatus = SharedHeaderStatus;

interface HeaderControls {
  root: HTMLElement;
  setStatus(status: HeaderStatus): void;
  setHasConversation(has: boolean): void;
}

function createHeader(options: {
  onStartFresh: () => void;
  onOpenInRebel: () => void;
}): HeaderControls {
  const root = document.createElement('div');
  root.className = 'chat-header';

  const statusDot = document.createElement('span');
  statusDot.className = 'chat-header-dot';
  statusDot.setAttribute('aria-hidden', 'true');

  const title = document.createElement('span');
  title.className = 'chat-header-title';
  title.textContent = 'Rebel';

  const spacer = document.createElement('span');
  spacer.className = 'chat-header-spacer';

  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'chat-header-btn';
  openBtn.setAttribute('aria-label', 'Open in Rebel');
  openBtn.title = 'Open in Rebel';
  openBtn.innerHTML = svgExternal();
  openBtn.addEventListener('click', options.onOpenInRebel);

  const freshBtn = document.createElement('button');
  freshBtn.type = 'button';
  freshBtn.className = 'chat-header-btn';
  freshBtn.setAttribute('aria-label', 'Start fresh');
  freshBtn.title = 'Start fresh';
  freshBtn.innerHTML = svgRefresh();
  freshBtn.addEventListener('click', options.onStartFresh);

  root.appendChild(statusDot);
  root.appendChild(title);
  root.appendChild(spacer);
  root.appendChild(openBtn);
  root.appendChild(freshBtn);

  return {
    root,
    setStatus(status: HeaderStatus): void {
      root.dataset.status = status;
    },
    setHasConversation(has: boolean): void {
      openBtn.disabled = !has;
      freshBtn.disabled = !has;
    },
  };
}

interface ComposerControls {
  root: HTMLElement;
  setDisabled(disabled: boolean): void;
  setPlaceholder(text: string): void;
}

function createComposer(options: {
  onSend: (text: string) => void;
}): ComposerControls {
  const root = document.createElement('div');
  root.className = 'chat-composer';

  const field = document.createElement('div');
  field.className = 'chat-composer-field';

  const textarea = document.createElement('textarea');
  textarea.className = 'chat-composer-textarea';
  textarea.rows = 1;
  textarea.setAttribute('aria-label', 'Message Rebel');

  const sendBtn = document.createElement('button');
  sendBtn.type = 'button';
  sendBtn.className = 'chat-composer-send';
  sendBtn.setAttribute('aria-label', 'Send message');
  sendBtn.title = 'Send';
  sendBtn.innerHTML = svgSend();

  const autosize = (): void => {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
  };

  const submit = (): void => {
    const value = textarea.value;
    const trimmed = value.trim();
    if (!trimmed) return;
    if (textarea.disabled) return;
    textarea.value = '';
    autosize();
    options.onSend(trimmed);
  };

  textarea.addEventListener('input', autosize);
  textarea.addEventListener('keydown', (ev: KeyboardEvent) => {
    if (ev.key !== 'Enter') return;
    if (ev.shiftKey) return;
    const native = ev as KeyboardEvent & { isComposing?: boolean };
    if (native.isComposing) return;
    ev.preventDefault();
    submit();
  });
  sendBtn.addEventListener('click', submit);

  field.appendChild(textarea);
  field.appendChild(sendBtn);
  root.appendChild(field);

  return {
    root,
    setDisabled(disabled: boolean): void {
      textarea.disabled = disabled;
      sendBtn.disabled = disabled;
      root.classList.toggle('is-disabled', disabled);
    },
    setPlaceholder(text: string): void {
      textarea.placeholder = text;
    },
  };
}

function createNotReadyPanel(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'chat-empty';

  const title = document.createElement('h2');
  title.className = 'chat-empty-title';
  title.textContent = 'Rebel is setting up';

  const body = document.createElement('p');
  body.className = 'chat-empty-body';
  body.textContent = NOT_READY_COPY;

  wrap.appendChild(title);
  wrap.appendChild(body);
  return wrap;
}

function createEmptyStatePanel(ctx: DocumentContext): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'chat-empty';

  const title = document.createElement('h2');
  title.className = 'chat-empty-title';
  title.textContent = 'What can I help you with?';

  const body = document.createElement('p');
  body.className = 'chat-empty-body';
  body.textContent =
    "Ask about this document, ask me to draft something, or ask me anything else. I'll see what you're working on.";

  wrap.appendChild(title);
  wrap.appendChild(body);

  const contextChip = buildConversationContextChip({
    pageTitle: ctx.title,
    pageUrl: ctx.url,
  });
  if (contextChip) {
    wrap.appendChild(createContextChip(contextChip));
  }
  return wrap;
}

function buildConversationContextChip(
  ctx: ConversationContext,
): ContextChipViewModel | null {
  return buildContextChipViewModel({
    ...(ctx.pageTitle ? { pageTitle: ctx.pageTitle } : {}),
    ...(ctx.pageUrl ? { pageUrl: ctx.pageUrl } : {}),
    fallbackTitle: 'This document',
  });
}

function createContextChip(contextChip: ContextChipViewModel): HTMLElement {
  const chip = document.createElement('div');
  chip.className = 'chat-context-chip';
  chip.title = contextChip.tooltip;

  const icon = document.createElement('span');
  icon.className = 'chat-context-chip-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = svgDocument();
  chip.appendChild(icon);

  const textWrap = document.createElement('div');
  textWrap.className = 'chat-context-chip-text';

  const titleEl = document.createElement('div');
  titleEl.className = 'chat-context-chip-title';
  titleEl.textContent = contextChip.primaryText;
  textWrap.appendChild(titleEl);

  if (contextChip.secondaryText) {
    const urlEl = document.createElement('div');
    urlEl.className = 'chat-context-chip-url';
    urlEl.textContent = contextChip.secondaryText;
    textWrap.appendChild(urlEl);
  }

  chip.appendChild(textWrap);
  return chip;
}

function formatMessageTimestampTitle(date: Date): string {
  try {
    return date.toLocaleString();
  } catch {
    return '';
  }
}

function renderMessageList(
  list: HistoryMessage[],
  streamingText: string,
  turnStatus: 'idle' | 'running',
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'chat-messages';

  const entries = buildConversationEntries({
    messages: list,
    streamingText,
    turnStatus,
    now: Date.now(),
    formatTimestampTitle: formatMessageTimestampTitle,
  });

  for (const entry of entries) {
    wrap.appendChild(createConversationEntry(entry));
  }

  return wrap;
}

function createConversationEntry(entry: ConversationEntryViewModel): HTMLElement {
  const row = document.createElement('div');
  row.className = `chat-msg chat-msg-${entry.role}`;
  row.dataset.kind = entry.kind;
  row.dataset.role = entry.role;

  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble';

  switch (entry.kind) {
    case 'message':
      bubble.textContent = normalizeText(entry.text);
      bubble.title = entry.timestamp.title;
      bubble.dataset.relativeTime = entry.timestamp.relativeLabel;
      row.appendChild(bubble);
      if (entry.partial && entry.partialLabel) {
        const partial = document.createElement('div');
        partial.className = 'chat-msg-partial';
        partial.dataset.kind = 'partial';
        partial.textContent = normalizeText(entry.partialLabel);
        row.appendChild(partial);
      }
      return row;
    case 'streaming': {
      row.classList.add('is-streaming');
      bubble.textContent = normalizeText(entry.text);
      const cursor = document.createElement('span');
      cursor.className = 'chat-cursor';
      cursor.setAttribute('aria-hidden', 'true');
      bubble.appendChild(cursor);
      row.appendChild(bubble);
      return row;
    }
    case 'thinking':
      bubble.classList.add('chat-thinking');
      bubble.setAttribute('aria-label', normalizeText(entry.label));
      for (let i = 0; i < 3; i += 1) {
        const dot = document.createElement('span');
        dot.className = 'chat-thinking-dot';
        bubble.appendChild(dot);
      }
      row.appendChild(bubble);
      return row;
  }

  const exhaustiveEntry: never = entry;
  throw new Error(`Unsupported Office conversation entry: ${exhaustiveEntry}`);
}

function createErrorBanner(
  message: string,
  kind: ConversationNoticeViewModel['kind'],
): HTMLElement {
  const banner = document.createElement('div');
  banner.className = 'chat-error';
  banner.dataset.kind = kind;
  banner.setAttribute('role', 'alert');
  banner.textContent = normalizeText(message);
  return banner;
}

function messageForConversationNotice(
  notice: ConversationNoticeViewModel,
): string {
  switch (notice.kind) {
    case 'reconnecting':
      return notice.message ?? 'Reconnecting to Rebel now.';
    case 'offline':
      return notice.message ?? STREAM_DROPPED_COPY;
    case 'revoked':
      return REVOKED_COPY;
    case 'error':
      return notice.message ?? 'Something went sideways. Try again in a moment.';
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Decide which value goes on the header's `data-status` dataset. Kept pure
 * and exported so tests can lock in the priority order:
 *   not-ready > reconnecting > degraded > connected
 */
export function computeHeaderStatus(
  phase: ChatPhase,
  health: ConnectionHealth,
): HeaderStatus {
  return resolveHeaderStatus({
    surfaceReady: phase !== 'not-ready',
    connectionHealth: health,
  });
}

/** Exposed for test coverage of the connectivity-error classifier. */
export const CONNECTIVITY_ERROR_CODES_INTERNAL: ReadonlySet<ChatErrorCode> =
  CONNECTIVITY_ERROR_CODES;

function friendlyError(code: string, fallback: string): string {
  switch (code) {
    case 'NOT_IMPLEMENTED':
      return "Rebel can't do that yet — the feature is still landing.";
    case 'APP_NOT_CONNECTED':
    case 'PORT_UNREACHABLE':
      return "Rebel isn't reachable right now. Is the desktop app open?";
    case 'UNAUTHORIZED':
      return NOT_READY_COPY;
    case 'NETWORK_ERROR':
    case 'TIMEOUT':
      return "Rebel isn't responding right now. Try again in a moment.";
    case 'BAD_REQUEST':
      return fallback || 'Rebel rejected that message.';
    case 'NOT_FOUND':
      return fallback || 'This conversation was cleared in Rebel. Starting fresh.';
    case 'BUSY':
      return 'Rebel is already working on your previous message.';
    case 'MISSING_CONTEXT':
      return fallback || MISSING_CONTEXT_COPY;
    default:
      return fallback || 'Something went sideways. Try again in a moment.';
  }
}

// ---------------------------------------------------------------------------
// Icons (inline SVG — no icon library in the Office add-in)
// ---------------------------------------------------------------------------

function svgExternal(): string {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>`;
}

function svgRefresh(): string {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg>`;
}

function svgSend(): string {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13"/><path d="m22 2-7 20-4-9-9-4z"/></svg>`;
}

function svgDocument(): string {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
}
