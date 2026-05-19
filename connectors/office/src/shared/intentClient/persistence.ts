export interface PersistedChatState {
  conversationId: string;
  conversationTitle?: string;
  createdAt?: number;
  pageTitle?: string;
  pageUrl?: string;
}

export interface ChatStatePersistence {
  get(): Promise<PersistedChatState | null>;
  set(state: PersistedChatState): Promise<void>;
  clear(): Promise<void>;
  subscribe?(onChange: () => void): () => void;
}

export interface ChatStatePersistenceConformanceResult {
  initialState: PersistedChatState | null;
  afterSetState: PersistedChatState | null;
  afterClearState: PersistedChatState | null;
}

function cloneState(state: PersistedChatState | null): PersistedChatState | null {
  if (!state) return null;
  return { ...state };
}

function notify(listeners: Set<() => void>): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // Intentionally swallowed: state-change listeners are best-effort.
    }
  }
}

export function createInMemoryChatStatePersistence(
  initialState: PersistedChatState | null = null,
): ChatStatePersistence {
  let state = cloneState(initialState);
  const listeners = new Set<() => void>();

  return {
    async get(): Promise<PersistedChatState | null> {
      return cloneState(state);
    },

    async set(nextState: PersistedChatState): Promise<void> {
      state = cloneState(nextState);
      notify(listeners);
    },

    async clear(): Promise<void> {
      state = null;
      notify(listeners);
    },

    subscribe(onChange: () => void): () => void {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
  };
}

/**
 * Shared conformance harness so every persistence adapter can be exercised
 * against the same lifecycle contract.
 */
export async function runChatStatePersistenceConformance(
  persistence: ChatStatePersistence,
  sampleState: PersistedChatState,
): Promise<ChatStatePersistenceConformanceResult> {
  const initialState = await persistence.get();
  await persistence.set(sampleState);
  const afterSetState = await persistence.get();
  await persistence.clear();
  const afterClearState = await persistence.get();
  return { initialState, afterSetState, afterClearState };
}
