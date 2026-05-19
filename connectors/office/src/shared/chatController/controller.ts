import type {
  ConnectStreamError,
  ConnectStreamEvent,
  ConnectStreamHandlers,
  DiagnosticSink,
  IntentClient,
  IntentClientError,
  IntentTransportAdapter,
  PersistedChatState,
  StreamCloseReason,
} from '../intentClient/index.js';
import { isResponseError } from '../intentClient/index.js';
import type {
  ChatController,
  ChatControllerDiagnosticEvent,
  ChatControllerError,
  ChatControllerSnapshot,
  ChatContext,
  ChatMessage,
  ChatStatePersistence,
  ContextProvider,
} from './types.js';
import { runOfflineProbeLoop } from './offlineProbe.js';

const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000] as const;
const NEW_CONVERSATION_HISTORY_RETRY_DELAYS_MS = [50, 100, 200, 400, 800] as const;
const RETRYABLE_ERROR_CODES = new Set([
  'APP_NOT_CONNECTED',
  'PORT_UNREACHABLE',
  'NETWORK_ERROR',
  'TIMEOUT',
  'BRIDGE_UNAVAILABLE',
  'BRIDGE_ERROR',
]);
const EMPTY_SNAPSHOT: ChatControllerSnapshot = {
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

interface ActiveStream {
  conversationId: string;
  requestId: string;
  close: () => void;
}

interface RequestLane {
  requestId: string;
  abortController: AbortController;
}

function cloneSnapshot(snapshot: ChatControllerSnapshot): ChatControllerSnapshot {
  return {
    ...snapshot,
    conversationContext: { ...snapshot.conversationContext },
    messages: snapshot.messages.map((message) => ({ ...message })),
    ...(snapshot.error ? { error: { ...snapshot.error } } : {}),
  };
}

export function createChatController(opts: {
  client: IntentClient;
  transport?: Pick<IntentTransportAdapter, 'probeReachability' | 'isReachable'>;
  persistence?: ChatStatePersistence;
  diagnostics?: DiagnosticSink;
  context?: ContextProvider;
  missingContextMessage?: string;
}): ChatController {
  let snapshot: ChatControllerSnapshot = cloneSnapshot(EMPTY_SNAPSHOT);
  let streamingText = '';
  let streamingTurnId: string | null = null;
  let activeStream: ActiveStream | null = null;
  let activeRequest: RequestLane | null = null;
  let auxiliaryRequest: RequestLane | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let intentionalClose = false;
  let disposed = false;
  let offlineLoop: ReturnType<typeof runOfflineProbeLoop> | null = null;
  let initialized = false;
  let controllerGeneration = 0;

  const stateListeners = new Set<() => void>();
  const streamingListeners = new Set<() => void>();
  const missingContextMessage =
    opts.missingContextMessage ?? 'Open a page in your browser, then try again.';
  const probeReachability = opts.transport?.probeReachability ?? opts.transport?.isReachable ?? null;

  void hydrate();

  return {
    getSnapshot(): ChatControllerSnapshot {
      return snapshot;
    },

    subscribe(listener: () => void): () => void {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },

    getStreamingText(): string {
      return streamingText;
    },

    subscribeStreamingText(listener: () => void): () => void {
      streamingListeners.add(listener);
      return () => {
        streamingListeners.delete(listener);
      };
    },

    async send(text: string): Promise<void> {
      const trimmed = text.trim();
      if (!trimmed) return;

      await ensureHydrated();
      if (disposed) return;
      if (isBusy(snapshot.phase)) {
        throw createControllerError('BUSY', 'Rebel is already working on a message.');
      }

      const optimisticMessage = createOptimisticUserMessage(trimmed);
      setSnapshot({
        ...snapshot,
        messages: mergeIncomingMessage(snapshot.messages, optimisticMessage),
        error: null,
        retryableSend: null,
        phase: 'sending',
        turnStatus: 'running',
        creatingConversation: snapshot.conversationId === null,
      });
      clearStreamingDraft();

      const requestId = beginRequest();
      const capturedContext = await readContext(opts.context);
      if (disposed || !isActiveRequest(requestId)) return;

      if (!snapshot.conversationId && !hasSendContext(capturedContext)) {
        setSnapshot({
          ...snapshot,
          messages: rollbackOptimistic(snapshot.messages, optimisticMessage.id),
          phase: 'idle',
          turnStatus: 'idle',
          creatingConversation: false,
          error: createControllerError('MISSING_CONTEXT', missingContextMessage),
        });
        clearActiveRequest(requestId);
        return;
      }

      try {
        if (!snapshot.conversationId) {
          await createConversation(trimmed, capturedContext, requestId);
        } else {
          await sendFollowUp(trimmed, capturedContext, requestId);
        }
      } catch (error) {
        if (!isActiveRequest(requestId)) {
          return;
        }
        setSnapshot({
          ...snapshot,
          messages: rollbackOptimistic(snapshot.messages, optimisticMessage.id),
        });
        const mappedError = toControllerError(error);
        clearActiveRequest(requestId);
        await applyOperationError({
          requestId,
          text: trimmed,
          error: mappedError,
          missingConversation: snapshot.conversationId === null,
          generation: controllerGeneration,
        });
        return;
      }

      clearActiveRequest(requestId);
      if (disposed) return;
      setSnapshot({
        ...snapshot,
        phase: streamingText.length > 0 || snapshot.turnStatus === 'running' ? 'streaming' : 'idle',
        creatingConversation: false,
        reconnectAttempt: 0,
      });
    },

    async startFresh(): Promise<void> {
      bumpControllerGeneration();
      cancelReconnectTimer();
      cancelOfflineLoop();
      abortActiveRequest('start-fresh');
      abortAuxiliaryRequest();
      closeActiveStream(true);
      reconnectAttempt = 0;
      if (opts.persistence) {
        await opts.persistence.clear().catch(() => undefined);
      }
      clearStreamingDraft();
      setSnapshot({
        ...cloneSnapshot(EMPTY_SNAPSHOT),
        phase: initialized ? 'idle' : 'hydrating',
      });
    },

    async openInRebel(): Promise<void> {
      await ensureHydrated();
      const conversationId = snapshot.conversationId;
      if (!conversationId) return;
      const requestId = beginAuxiliaryRequest();
      try {
        await opts.client.focusInRebel(
          { conversationId },
          auxiliaryRequest?.abortController.signal,
        );
      } catch (error) {
        if (!isActiveAuxiliaryRequest(requestId)) return;
        const mappedError = toControllerError(error);
        clearAuxiliaryRequest(requestId);
        setSnapshot({
          ...snapshot,
          error: mappedError,
        });
        return;
      }
      clearAuxiliaryRequest(requestId);
    },

    dispose(): void {
      if (disposed) return;
      bumpControllerGeneration();
      disposed = true;
      cancelReconnectTimer();
      cancelOfflineLoop();
      abortActiveRequest('dispose');
      abortAuxiliaryRequest();
      closeActiveStream(true);
      stateListeners.clear();
      streamingListeners.clear();
    },
  };

  async function hydrate(): Promise<void> {
    if (disposed || initialized) return;
    initialized = true;
    if (!opts.persistence) {
      setSnapshot({
        ...snapshot,
        phase: 'idle',
      });
      return;
    }

    let persisted: PersistedChatState | null = null;
    try {
      persisted = await opts.persistence.get();
    } catch {
      persisted = null;
    }

    if (disposed) return;
    if (!persisted?.conversationId) {
      setSnapshot({
        ...snapshot,
        phase: 'idle',
      });
      return;
    }

    setSnapshot({
      ...snapshot,
      conversationId: persisted.conversationId,
      conversationContext: {
        ...(persisted.pageTitle ? { pageTitle: persisted.pageTitle } : {}),
        ...(persisted.pageUrl ? { pageUrl: persisted.pageUrl } : {}),
      },
    });

    try {
      await restoreConversation(persisted.conversationId, 'hydrate');
    } catch {
      if (!disposed && snapshot.phase === 'hydrating') {
        setSnapshot({
          ...snapshot,
          phase: 'idle',
        });
      }
    }
  }

  async function ensureHydrated(): Promise<void> {
    if (initialized) {
      while (!disposed && snapshot.phase === 'hydrating') {
        await Promise.resolve();
      }
      return;
    }
    await hydrate();
  }

  async function createConversation(
    text: string,
    context: ChatContext | null,
    requestId: string,
  ): Promise<void> {
    const result = await opts.client.createConversation(
      {
        intent: 'chat',
        userText: text,
        switchToConversation: false,
        ...(context?.tabContext ? { tabContext: context.tabContext } : {}),
        ...(context?.pageContext ? { pageContext: context.pageContext } : {}),
        ...(context?.documentContext ? { documentContext: context.documentContext } : {}),
      },
      activeRequest?.abortController.signal,
    );

    if (!isActiveRequest(requestId) || disposed) return;

    const nextConversationContext = {
      ...snapshot.conversationContext,
      ...deriveConversationContext(context),
    };
    setSnapshot({
      ...snapshot,
      conversationId: result.conversationId,
      conversationContext: nextConversationContext,
      creatingConversation: false,
    });
    await persistConversation(result.conversationId, nextConversationContext);
    await restoreConversation(result.conversationId, 'new-conversation', controllerGeneration);
  }

  async function sendFollowUp(
    text: string,
    context: ChatContext | null,
    requestId: string,
  ): Promise<void> {
    const conversationId = snapshot.conversationId;
    if (!conversationId) {
      throw createIntentClientError('UNKNOWN', 'Conversation is missing.');
    }

    await opts.client.sendMessage(
      {
        conversationId,
        text,
        ...(context?.tabContext ? { tabContext: context.tabContext } : {}),
        ...(context?.pageContext ? { pageContext: context.pageContext } : {}),
        ...(context?.documentContext ? { documentContext: context.documentContext } : {}),
      },
      activeRequest?.abortController.signal,
    );

    if (disposed || !isActiveRequest(requestId)) return;
    if (!activeStream || activeStream.conversationId !== conversationId) {
      openStream(conversationId, requestId, controllerGeneration);
    }
  }

  async function restoreConversation(
    conversationId: string,
    trigger: 'hydrate' | 'new-conversation' | 'reconnect' | 'offline-recovery',
    generation = controllerGeneration,
  ): Promise<void> {
    if (!isCurrentGeneration(generation)) return;
    const requestId = activeRequest?.requestId ?? createRequestId();
    let history: Awaited<ReturnType<IntentClient['getHistory']>>;
    try {
      history = await getHistoryWithNewConversationRetry(conversationId, trigger);
      if (!isCurrentGeneration(generation)) return;
      let nextMessages = snapshot.messages;
      if (history.turnStatus !== 'running') {
        nextMessages = snapshotStreamingPartialMessage({
          messages: nextMessages,
          fallbackId: requestId,
        });
      }
      setSnapshot({
        ...snapshot,
        phase: history.turnStatus === 'running' ? 'streaming' : 'idle',
        conversationId,
        messages: mergeHistoryMessages(nextMessages, history.messages),
        turnStatus: history.turnStatus,
        error: shouldRetainHeldMessageError(snapshot.retryableSend, snapshot.error)
          ? snapshot.error
          : null,
        reconnectAttempt: trigger === 'reconnect' ? 0 : snapshot.reconnectAttempt,
      });
      if (history.turnStatus !== 'running') {
        clearStreamingDraft();
      }
      openStream(conversationId, requestId, generation);
    } catch (error) {
      if (!isCurrentGeneration(generation)) return;
      const mapped = toControllerError(error);
      if (mapped.code === 'NOT_FOUND') {
        const resetGeneration = bumpControllerGeneration();
        await opts.persistence?.clear().catch(() => undefined);
        if (!isCurrentGeneration(resetGeneration)) return;
        clearStreamingDraft();
        setSnapshot({
          ...cloneSnapshot(EMPTY_SNAPSHOT),
          phase: 'idle',
          error: createControllerError('NOT_FOUND', 'This conversation was cleared in Rebel. Starting fresh.'),
        });
        return;
      }
      if (mapped.code === 'UNAUTHORIZED' || mapped.code === 'FORBIDDEN' || mapped.code === 'REVOKED') {
        bumpControllerGeneration();
        closeActiveStream(true);
        const messages = snapshotStreamingPartialMessage({ fallbackId: requestId });
        clearStreamingDraft();
        setSnapshot({
          ...snapshot,
          messages,
          phase: 'revoked',
          error: createControllerError('UNAUTHORIZED', mapped.message, mapped.status),
          turnStatus: 'idle',
          creatingConversation: false,
        });
        closeActiveStream(true);
        return;
      }
      if (isRetryableCode(mapped.code) && probeReachability) {
        const reachable = await probeTransport('stream-error', requestId);
        if (!isCurrentGeneration(generation)) return;
        if (!reachable) {
          enterOffline({ requestId, trigger: 'stream-error' }, generation);
          return;
        }
      }
      const messages = snapshotStreamingPartialMessage({ fallbackId: requestId });
      clearStreamingDraft();
      setSnapshot({
        ...snapshot,
        messages,
        phase: 'idle',
        error: mapped,
        turnStatus: 'idle',
        creatingConversation: false,
      });
      throw error;
    }
  }

  async function getHistoryWithNewConversationRetry(
    conversationId: string,
    trigger: 'hydrate' | 'new-conversation' | 'reconnect' | 'offline-recovery',
  ): Promise<Awaited<ReturnType<IntentClient['getHistory']>>> {
    let attempt = 0;
    while (true) {
      try {
        return await opts.client.getHistory(
          { conversationId },
          activeRequest?.abortController.signal,
        );
      } catch (error) {
        const mapped = toControllerError(error);
        const delay = NEW_CONVERSATION_HISTORY_RETRY_DELAYS_MS[attempt];
        if (trigger !== 'new-conversation' || mapped.code !== 'NOT_FOUND' || delay === undefined) {
          throw error;
        }
        attempt += 1;
        await sleep(delay);
      }
    }
  }

  function openStream(conversationId: string, requestId: string, generation: number): void {
    if (!isCurrentGeneration(generation)) return;
    closeActiveStream(true);
    if (!isCurrentGeneration(generation)) return;
    intentionalClose = false;
    const connection = opts.client.connectStream(
      { conversationId },
      createStreamHandlers(conversationId, requestId, generation),
    );
    activeStream = {
      conversationId,
      requestId,
      close: connection.close,
    };
  }

  function createStreamHandlers(
    conversationId: string,
    requestId: string,
    generation: number,
  ): ConnectStreamHandlers {
    return {
      onEvent: (event) => {
        if (!isCurrentGeneration(generation)) {
          return;
        }
        if (!activeStream || activeStream.requestId !== requestId || activeStream.conversationId !== conversationId) {
          return;
        }
        applyStreamEvent(event);
      },
      onError: (error) => {
        if (!isCurrentGeneration(generation)) {
          return;
        }
        if (!activeStream || activeStream.requestId !== requestId || activeStream.conversationId !== conversationId) {
          return;
        }
        void handleStreamError(conversationId, requestId, error, generation);
      },
      onClose: (reason) => {
        if (!isCurrentGeneration(generation)) {
          return;
        }
        if (!activeStream || activeStream.requestId !== requestId || activeStream.conversationId !== conversationId) {
          return;
        }
        void handleStreamClose(conversationId, requestId, reason, generation);
      },
    };
  }

  function applyStreamEvent(event: ConnectStreamEvent): void {
    switch (event.type) {
      case 'connected': {
        reconnectAttempt = 0;
        cancelReconnectTimer();
        cancelOfflineLoop();
        const nextMessages =
          event.turnStatus === 'running'
            ? snapshot.messages
            : snapshotStreamingPartialMessage();
        setSnapshot({
          ...snapshot,
          messages: nextMessages,
          phase: event.turnStatus === 'running' ? 'streaming' : 'idle',
          turnStatus: event.turnStatus === 'running' ? 'running' : 'idle',
          reconnectAttempt: 0,
          error: shouldRetainHeldMessageError(snapshot.retryableSend, snapshot.error)
            ? snapshot.error
            : null,
        });
        if (event.turnStatus !== 'running') {
          clearStreamingDraft();
        }
        return;
      }
      case 'turn_started': {
        streamingTurnId = event.turnId;
        setStreamingText('');
        setSnapshot({
          ...snapshot,
          phase: 'streaming',
          turnStatus: 'running',
          error: null,
        });
        return;
      }
      case 'assistant_delta': {
        streamingTurnId = event.turnId;
        setStreamingText(streamingText + event.text);
        setSnapshot({
          ...snapshot,
          phase: 'streaming',
          turnStatus: 'running',
        });
        return;
      }
      case 'assistant_done': {
        if (streamingText.length > 0) {
          setSnapshot({
            ...snapshot,
            messages: mergeIncomingMessage(
              snapshot.messages,
              createAssistantPlaceholderMessage({
                text: streamingText,
                turnId: streamingTurnId ?? event.turnId,
                partial: false,
              }),
            ),
            phase: 'idle',
            turnStatus: 'idle',
          });
        } else {
          setSnapshot({
            ...snapshot,
            phase: 'idle',
            turnStatus: 'idle',
          });
        }
        clearStreamingDraft();
        return;
      }
      case 'message_added': {
        setSnapshot({
          ...snapshot,
          messages: mergeIncomingMessage(
            snapshot.messages,
            attachAssistantTurnMetadata(event.message, streamingTurnId),
          ),
        });
        return;
      }
      case 'turn_error': {
        const messages = snapshotStreamingPartialMessage({
          fallbackId: event.turnId,
        });
        clearStreamingDraft();
        setSnapshot({
          ...snapshot,
          messages,
          phase: 'idle',
          turnStatus: 'idle',
          error: createControllerError('BRIDGE_ERROR', event.error || 'Rebel hit a snag mid-response. Try again in a moment.'),
        });
        return;
      }
      case 'tool_activity': {
        return;
      }
      case 'revoked': {
        bumpControllerGeneration();
        closeActiveStream(true);
        const messages = snapshotStreamingPartialMessage();
        clearStreamingDraft();
        setSnapshot({
          ...snapshot,
          messages,
          phase: 'revoked',
          turnStatus: 'idle',
          error: createControllerError('UNAUTHORIZED', 'Your connection to Rebel was reset. Open Rebel and run the browser install again.'),
        });
        return;
      }
      default:
        return;
    }
  }

  async function handleStreamError(
    conversationId: string,
    requestId: string,
    error: ConnectStreamError,
    generation: number,
  ): Promise<void> {
    activeStream = null;
    const mapped = toControllerError(error);
    if (mapped.code === 'UNAUTHORIZED' || mapped.code === 'FORBIDDEN' || mapped.code === 'REVOKED') {
      bumpControllerGeneration();
      closeActiveStream(true);
      const messages = snapshotStreamingPartialMessage({ fallbackId: requestId });
      clearStreamingDraft();
      setSnapshot({
        ...snapshot,
        messages,
        phase: 'revoked',
        turnStatus: 'idle',
        error: createControllerError('UNAUTHORIZED', mapped.message, mapped.status),
      });
      return;
    }
    if (isRetryableCode(mapped.code)) {
      if (probeReachability) {
        const reachable = await probeTransport('stream-error', requestId);
        if (!isCurrentGeneration(generation)) return;
        if (!reachable) {
          enterOffline({ requestId, trigger: 'stream-error' }, generation);
          return;
        }
      }
      scheduleReconnect(conversationId, requestId, generation);
      return;
    }
    const messages = snapshotStreamingPartialMessage({ fallbackId: requestId });
    clearStreamingDraft();
    setSnapshot({
      ...snapshot,
      messages,
      phase: 'idle',
      turnStatus: 'idle',
      error: mapped,
    });
  }

  async function handleStreamClose(
    conversationId: string,
    requestId: string,
    reason: StreamCloseReason,
    generation: number,
  ): Promise<void> {
    activeStream = null;
    if (!isCurrentGeneration(generation) || intentionalClose) {
      intentionalClose = false;
      return;
    }
    if (snapshot.phase === 'revoked' || reason === 'revoked') {
      bumpControllerGeneration();
      closeActiveStream(true);
      const messages = snapshotStreamingPartialMessage({ fallbackId: requestId });
      clearStreamingDraft();
      setSnapshot({
        ...snapshot,
        messages,
        phase: 'revoked',
        turnStatus: 'idle',
        error: createControllerError('UNAUTHORIZED', 'Your connection to Rebel was reset. Open Rebel and run the browser install again.'),
      });
      return;
    }
    if (reason === 'aborted') {
      setSnapshot({
        ...snapshot,
        phase: 'idle',
        turnStatus: 'idle',
      });
      return;
    }
    scheduleReconnect(conversationId, requestId, generation);
  }

  function scheduleReconnect(conversationId: string, requestId: string, generation: number): void {
    if (!isCurrentGeneration(generation)) return;
    cancelReconnectTimer();
    if (reconnectAttempt >= RECONNECT_DELAYS_MS.length) {
      void probeTransport('stream-close', requestId).then((reachable) => {
        if (!isCurrentGeneration(generation)) return;
        if (reachable) {
          reconnectAttempt = 0;
          void restoreConversation(conversationId, 'reconnect', generation);
          return;
        }
        enterOffline({ requestId, trigger: 'stream-close' }, generation);
      });
      return;
    }
    const nextAttempt = reconnectAttempt + 1;
    reconnectAttempt = nextAttempt;
    setSnapshot({
      ...snapshot,
      phase: 'reconnecting',
      reconnectAttempt: nextAttempt,
      turnStatus: 'running',
    });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!isCurrentGeneration(generation)) return;
      void restoreConversation(conversationId, 'reconnect', generation);
    }, RECONNECT_DELAYS_MS[nextAttempt - 1]);
  }

  function enterOffline(
    input: { requestId: string; trigger: 'send-error' | 'stream-error' | 'stream-close' },
    generation: number,
  ): void {
    if (!isCurrentGeneration(generation)) return;
    cancelReconnectTimer();
    cancelOfflineLoop();
    const messages =
      input.trigger === 'send-error'
        ? snapshot.messages
        : snapshotStreamingPartialMessage({ fallbackId: input.requestId });
    if (input.trigger !== 'send-error') {
      clearStreamingDraft();
    }
    setSnapshot({
      ...snapshot,
      messages,
      phase: 'offline',
      reconnectAttempt,
      turnStatus: 'idle',
    });
    if (!probeReachability) return;
    offlineLoop = runOfflineProbeLoop({
      probe: async () => Boolean(await probeTransport(input.trigger, input.requestId, offlineLoop?.currentAttempt() ?? undefined)),
      onOnline: () => {
        if (!isCurrentGeneration(generation)) return;
        cancelOfflineLoop();
        reconnectAttempt = 0;
        if (snapshot.conversationId) {
          void restoreConversation(snapshot.conversationId, 'offline-recovery', generation);
          return;
        }
        setSnapshot({
          ...snapshot,
          phase: 'idle',
          reconnectAttempt: 0,
        });
      },
    });
  }

  async function applyOperationError(input: {
    requestId: string;
    text: string;
    error: ChatControllerError;
    missingConversation: boolean;
    generation: number;
  }): Promise<void> {
    if (input.error.code === 'NOT_FOUND') {
      const resetGeneration = bumpControllerGeneration();
      await opts.persistence?.clear().catch(() => undefined);
      if (!isCurrentGeneration(resetGeneration)) return;
      setSnapshot({
        ...cloneSnapshot(EMPTY_SNAPSHOT),
        phase: 'idle',
        error: createControllerError('NOT_FOUND', 'This conversation was cleared in Rebel. Starting fresh.'),
      });
      return;
    }
    if (input.error.code === 'UNAUTHORIZED' || input.error.code === 'FORBIDDEN' || input.error.code === 'REVOKED') {
      bumpControllerGeneration();
      setSnapshot({
        ...snapshot,
        phase: 'revoked',
        turnStatus: 'idle',
        creatingConversation: false,
        error: createControllerError('UNAUTHORIZED', input.error.message, input.error.status),
      });
      return;
    }
    if (isRetryableCode(input.error.code) && probeReachability) {
      const reachable = await probeTransport('send-error', input.requestId);
      if (!isCurrentGeneration(input.generation)) return;
      if (!reachable) {
        setSnapshot({
          ...snapshot,
          phase: 'offline',
          turnStatus: 'idle',
          creatingConversation: false,
          retryableSend: input.text,
          error: input.error,
        });
        enterOffline({ requestId: input.requestId, trigger: 'send-error' }, controllerGeneration);
        return;
      }
    }
    setSnapshot({
      ...snapshot,
      phase: 'idle',
      turnStatus: 'idle',
      creatingConversation: false,
      retryableSend: isRetryableCode(input.error.code) ? input.text : null,
      error: input.error,
    });
  }

  async function probeTransport(
    trigger: 'send-error' | 'stream-error' | 'stream-close',
    requestId: string,
    attempt?: number,
  ): Promise<boolean> {
    if (!probeReachability) return false;
    try {
      const reachable = await probeReachability();
      emitDiagnostic({
        kind: 'controller.offline-probe',
        trigger,
        reachable,
        ...(typeof attempt === 'number' ? { attempt } : {}),
        requestId,
      });
      return reachable;
    } catch {
      emitDiagnostic({
        kind: 'controller.offline-probe',
        trigger,
        reachable: false,
        ...(typeof attempt === 'number' ? { attempt } : {}),
        requestId,
      });
      return false;
    }
  }

  function beginRequest(): string {
    abortActiveRequest();
    const requestId = createRequestId();
    activeRequest = {
      requestId,
      abortController: new AbortController(),
    };
    return requestId;
  }

  function beginAuxiliaryRequest(): string {
    abortAuxiliaryRequest();
    const requestId = createRequestId();
    auxiliaryRequest = {
      requestId,
      abortController: new AbortController(),
    };
    return requestId;
  }

  function clearActiveRequest(requestId?: string): void {
    if (!activeRequest) return;
    if (requestId && activeRequest.requestId !== requestId) return;
    activeRequest = null;
  }

  function isActiveRequest(requestId: string): boolean {
    return Boolean(activeRequest && activeRequest.requestId === requestId);
  }

  function clearAuxiliaryRequest(requestId?: string): void {
    if (!auxiliaryRequest) return;
    if (requestId && auxiliaryRequest.requestId !== requestId) return;
    auxiliaryRequest = null;
  }

  function isActiveAuxiliaryRequest(requestId: string): boolean {
    return Boolean(auxiliaryRequest && auxiliaryRequest.requestId === requestId);
  }

  function abortActiveRequest(source?: 'start-fresh' | 'dispose'): void {
    if (!activeRequest) return;
    const requestId = activeRequest.requestId;
    try {
      activeRequest.abortController.abort();
    } catch {
      // Abort is idempotent.
    }
    activeRequest = null;
    if (source) {
      emitDiagnostic({ kind: 'controller.abort', source, requestId });
    }
  }

  function abortAuxiliaryRequest(): void {
    if (!auxiliaryRequest) return;
    try {
      auxiliaryRequest.abortController.abort();
    } catch {
      // Abort is idempotent.
    }
    auxiliaryRequest = null;
  }

  function closeActiveStream(markIntentional = false): void {
    if (!activeStream) return;
    intentionalClose = markIntentional;
    const stream = activeStream;
    activeStream = null;
    try {
      stream.close();
    } catch {
      // Best effort.
    }
  }

  function cancelReconnectTimer(): void {
    if (!reconnectTimer) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function cancelOfflineLoop(): void {
    offlineLoop?.cancel();
    offlineLoop = null;
  }

  function bumpControllerGeneration(): number {
    controllerGeneration += 1;
    return controllerGeneration;
  }

  function isCurrentGeneration(generation: number): boolean {
    return !disposed && generation === controllerGeneration;
  }

  function clearStreamingDraft(): void {
    streamingTurnId = null;
    setStreamingText('');
  }

  function snapshotStreamingPartialMessage(input: {
    messages?: ChatMessage[];
    fallbackId?: string;
  } = {}): ChatMessage[] {
    const baseMessages = input.messages ?? snapshot.messages;
    if (streamingText.length === 0) {
      return baseMessages;
    }
    return mergeIncomingMessage(
      baseMessages,
      createAssistantPlaceholderMessage({
        text: streamingText,
        turnId: streamingTurnId ?? input.fallbackId ?? createRequestId(),
        partial: true,
      }),
    );
  }

  async function persistConversation(
    conversationId: string,
    conversationContext: ChatControllerSnapshot['conversationContext'],
  ): Promise<void> {
    if (!opts.persistence) return;
    await opts.persistence
      .set({
        conversationId,
        createdAt: Date.now(),
        ...(conversationContext.pageTitle ? { pageTitle: conversationContext.pageTitle } : {}),
        ...(conversationContext.pageUrl ? { pageUrl: conversationContext.pageUrl } : {}),
      })
      .catch(() => undefined);
  }

  function setSnapshot(nextSnapshot: ChatControllerSnapshot): void {
    if (disposed) return;
    if (areSnapshotsEqual(snapshot, nextSnapshot)) return;
    const previousPhase = snapshot.phase;
    snapshot = cloneSnapshot(nextSnapshot);
    emitDiagnostic({
      kind: 'controller.transition',
      from: previousPhase,
      to: snapshot.phase,
      conversationId: snapshot.conversationId,
      ...(activeRequest?.requestId ? { requestId: activeRequest.requestId } : {}),
    });
    for (const listener of stateListeners) {
      try {
        listener();
      } catch {
        // Listener isolation.
      }
    }
  }

  function setStreamingText(nextValue: string): void {
    if (streamingText === nextValue) return;
    streamingText = nextValue;
    for (const listener of streamingListeners) {
      try {
        listener();
      } catch {
        // Listener isolation.
      }
    }
  }

  function emitDiagnostic(event: ChatControllerDiagnosticEvent): void {
    if (!opts.diagnostics) return;
    try {
      (opts.diagnostics as { emit: (event: unknown) => void }).emit(event);
    } catch {
      // Diagnostics are best-effort.
    }
  }
}

function areSnapshotsEqual(left: ChatControllerSnapshot, right: ChatControllerSnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isBusy(phase: ChatControllerSnapshot['phase']): boolean {
  return phase === 'sending' || phase === 'streaming' || phase === 'reconnecting';
}

function hasSendContext(context: ChatContext | null): boolean {
  return Boolean(context?.tabContext || context?.pageContext || context?.documentContext);
}

async function readContext(contextProvider: ContextProvider | undefined): Promise<ChatContext | null> {
  if (!contextProvider) return null;
  try {
    return (await contextProvider.captureContext()) ?? null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deriveConversationContext(context: ChatContext | null): ChatControllerSnapshot['conversationContext'] {
  return {
    ...(context?.pageContext?.title ? { pageTitle: context.pageContext.title } : {}),
    ...(context?.pageContext?.url ? { pageUrl: context.pageContext.url } : {}),
    ...(!context?.pageContext?.title && context?.documentContext?.title
      ? { pageTitle: context.documentContext.title }
      : {}),
    ...(!context?.pageContext?.url && context?.documentContext?.url
      ? { pageUrl: context.documentContext.url }
      : {}),
    ...(!context?.pageContext?.title && context?.tabContext?.title
      ? { pageTitle: context.tabContext.title }
      : {}),
    ...(!context?.pageContext?.url && context?.tabContext?.url
      ? { pageUrl: context.tabContext.url }
      : {}),
  };
}

function createOptimisticUserMessage(text: string): ChatMessage {
  return {
    id: `user-local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    text,
    createdAt: Date.now(),
  };
}

function dedupeMessages(messages: ChatMessage[]): ChatMessage[] {
  const seen = new Set<string>();
  const deduped: ChatMessage[] = [];
  for (const message of messages) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    deduped.push({ ...message });
  }
  return deduped;
}



function mergeHistoryMessages(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  let merged = dedupeMessages(existing);
  for (const message of incoming) {
    merged = mergeIncomingMessage(merged, message);
  }
  return merged;
}

function mergeIncomingMessage(messages: ChatMessage[], incoming: ChatMessage): ChatMessage[] {
  if (messages.some((message) => message.id === incoming.id)) {
    return messages.map((message) => (message.id === incoming.id ? { ...incoming } : message));
  }
  if (incoming.role === 'user') {
    const optimisticIndex = messages.findIndex(
      (message) => message.role === 'user' && message.id.startsWith('user-local-') && message.text === incoming.text,
    );
    if (optimisticIndex >= 0) {
      return messages.map((message, index) => (index === optimisticIndex ? { ...incoming } : message));
    }
  }
  if (incoming.role === 'assistant') {
    const placeholderIndex = findAssistantPlaceholderIndex(messages, incoming);
    if (placeholderIndex >= 0) {
      return messages.map((message, index) => (index === placeholderIndex ? { ...incoming } : message));
    }
  }
  return dedupeMessages([...messages, incoming]);
}

function findAssistantPlaceholderIndex(messages: ChatMessage[], incoming: ChatMessage): number {
  if (incoming.role !== 'assistant' || !incoming.turnId) {
    return -1;
  }
  return messages.findIndex(
    (message) =>
      message.role === 'assistant' &&
      message.id.startsWith('stream-') &&
      message.turnId === incoming.turnId,
  );
}

function attachAssistantTurnMetadata(
  message: ChatMessage,
  turnId: string | null,
): ChatMessage {
  if (message.role !== 'assistant' || message.turnId || !turnId) {
    return message;
  }
  return {
    ...message,
    turnId,
  };
}

function createAssistantPlaceholderMessage(input: {
  text: string;
  turnId: string;
  partial: boolean;
}): ChatMessage {
  return {
    id: `stream-${input.turnId}`,
    role: 'assistant',
    text: input.text,
    createdAt: Date.now(),
    partial: input.partial,
    turnId: input.turnId,
  };
}

function createControllerError(
  code: ChatControllerError['code'],
  message: string,
  status?: number,
): ChatControllerError {
  return {
    code,
    message,
    ...(typeof status === 'number' ? { status } : {}),
  };
}

function createIntentClientError(code: IntentClientError['code'], message: string): IntentClientError {
  const error = new Error(message) as IntentClientError;
  error.name = 'IntentClientError';
  error.code = code;
  return error;
}

function toControllerError(error: unknown): ChatControllerError {
  if (isResponseError(error)) {
    return createControllerError(error.code, error.message, error.status);
  }
  const maybeIntentError = error as IntentClientError | null;
  if (maybeIntentError && typeof maybeIntentError.code === 'string') {
    return createControllerError(maybeIntentError.code, maybeIntentError.message, maybeIntentError.status);
  }
  if (error && typeof error === 'object' && 'errMsg' in error) {
    const shape = error as { errMsg?: unknown; isAbortError?: unknown };
    if (shape.isAbortError === true) {
      return createControllerError('TIMEOUT', typeof shape.errMsg === 'string' ? shape.errMsg : 'Request aborted.');
    }
    return createControllerError(
      'NETWORK_ERROR',
      typeof shape.errMsg === 'string' ? shape.errMsg : 'Unexpected chat error.',
    );
  }
  const message = error instanceof Error && error.message ? error.message : 'Unexpected chat error.';
  return createControllerError('UNKNOWN', message);
}

function rollbackOptimistic(messages: ChatMessage[], optimisticId: string): ChatMessage[] {
  return messages.filter((message) => message.id !== optimisticId);
}

function isRetryableCode(code: ChatControllerError['code']): boolean {
  return RETRYABLE_ERROR_CODES.has(code);
}

function shouldRetainHeldMessageError(
  retryableSend: string | null,
  error: ChatControllerSnapshot['error'],
): boolean {
  return Boolean(retryableSend && error);
}

function createRequestId(): string {
  return crypto.randomUUID();
}
