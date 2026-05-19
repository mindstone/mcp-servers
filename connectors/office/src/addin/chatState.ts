import type { ChatStatePersistence, PersistedChatState } from '../shared/intentClient/index.js';
import {
  hashOfficeScopeKey,
  rememberOfficeDocumentFingerprint,
  type OfficeDocumentScope,
} from './documentScope.js';

const CHAT_STATE_KEY_PREFIX = 'rebel.office.chat.scope.v1.';
const CHAT_STATE_INDEX_KEY = 'rebel.office.chat.scopes.v1';
const MAX_SCOPED_CHAT_RECORDS = 50;

export interface ChatState {
  conversationId: string | null;
  createdAt?: number;
  pageTitle?: string;
  pageUrl?: string;
}

const EMPTY_CHAT_STATE: ChatState = { conversationId: null };

interface ChatStateEnvelope {
  scope: {
    key: string;
    mode: OfficeDocumentScope['mode'];
    settingsId?: string;
    fingerprint?: string;
  };
  state: ChatState;
}

interface ChatStateIndexEntry {
  storageKey: string;
  scopeKeyHash: string;
  mode: OfficeDocumentScope['mode'];
  updatedAt: number;
}

function toChatState(raw: unknown): ChatState {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_CHAT_STATE };

  const candidate = raw as {
    conversationId?: unknown;
    createdAt?: unknown;
    pageTitle?: unknown;
    pageUrl?: unknown;
  };

  const state: ChatState = {
    conversationId:
      typeof candidate.conversationId === 'string' && candidate.conversationId.length > 0
        ? candidate.conversationId
        : null,
  };

  if (typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt)) {
    state.createdAt = candidate.createdAt;
  }
  if (typeof candidate.pageTitle === 'string' && candidate.pageTitle.length > 0) {
    state.pageTitle = candidate.pageTitle;
  }
  if (typeof candidate.pageUrl === 'string' && candidate.pageUrl.length > 0) {
    state.pageUrl = candidate.pageUrl;
  }

  return state;
}

function readScopedEnvelope(
  scope: OfficeDocumentScope,
  storage: Storage | null = getDefaultLocalStorage(),
): ChatStateEnvelope | null {
  try {
    const raw = storage?.getItem(getStorageKey(scope));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { scope?: unknown; state?: unknown } | null;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.scope || typeof parsed.scope !== 'object') return null;
    const storedScope = parsed.scope as Record<string, unknown>;
    if (typeof storedScope['key'] !== 'string' || typeof storedScope['mode'] !== 'string') {
      return null;
    }
    return {
      scope: {
        key: storedScope['key'],
        mode: storedScope['mode'] === 'durable' ? 'durable' : 'ephemeral',
        ...(typeof storedScope['settingsId'] === 'string'
          ? { settingsId: storedScope['settingsId'] }
          : {}),
        ...(typeof storedScope['fingerprint'] === 'string'
          ? { fingerprint: storedScope['fingerprint'] }
          : {}),
      },
      state: toChatState(parsed.state),
    };
  } catch {
    return null;
  }
}

function readIndex(storage: Storage | null): Record<string, ChatStateIndexEntry> {
  if (!storage) return {};
  try {
    const raw = storage?.getItem(CHAT_STATE_INDEX_KEY);
    if (!raw) return rebuildIndex(storage);
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') return rebuildIndex(storage);
    const next: Record<string, ChatStateIndexEntry> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object') continue;
      const entry = value as Record<string, unknown>;
      if (
        typeof entry['storageKey'] !== 'string' ||
        typeof entry['scopeKeyHash'] !== 'string' ||
        (entry['mode'] !== 'durable' && entry['mode'] !== 'ephemeral') ||
        typeof entry['updatedAt'] !== 'number'
      ) {
        continue;
      }
      next[key] = entry as unknown as ChatStateIndexEntry;
    }
    return next;
  } catch {
    return rebuildIndex(storage);
  }
}

function writeIndex(storage: Storage | null, index: Record<string, ChatStateIndexEntry>): boolean {
  if (!storage) return false;
  try {
    storage.setItem(CHAT_STATE_INDEX_KEY, JSON.stringify(index));
    return true;
  } catch {
    return false;
  }
}

function rebuildIndex(storage: Storage | null): Record<string, ChatStateIndexEntry> {
  if (!storage) return {};
  const rebuilt: Record<string, ChatStateIndexEntry> = {};
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const storageKey = storage.key(index);
      if (!storageKey?.startsWith(CHAT_STATE_KEY_PREFIX)) continue;
      const raw = storage.getItem(storageKey);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as { scope?: unknown; state?: unknown } | null;
      if (!parsed?.scope || typeof parsed.scope !== 'object') continue;
      const storedScope = parsed.scope as Record<string, unknown>;
      if (
        typeof storedScope['key'] !== 'string' ||
        (storedScope['mode'] !== 'durable' && storedScope['mode'] !== 'ephemeral')
      ) {
        continue;
      }
      const state = toChatState(parsed.state);
      rebuilt[storageKey] = {
        storageKey,
        scopeKeyHash: hashOfficeScopeKey(storedScope['key']),
        mode: storedScope['mode'],
        updatedAt: state.createdAt ?? 0,
      };
    }
  } catch {
    return {};
  }
  return rebuilt;
}

function toPersistedState(state: ChatState): PersistedChatState | null {
  if (!state.conversationId) {
    return null;
  }

  return {
    conversationId: state.conversationId,
    ...(typeof state.createdAt === 'number' && Number.isFinite(state.createdAt)
      ? { createdAt: state.createdAt }
      : {}),
    ...(typeof state.pageTitle === 'string' && state.pageTitle.length > 0
      ? { pageTitle: state.pageTitle }
      : {}),
    ...(typeof state.pageUrl === 'string' && state.pageUrl.length > 0
      ? { pageUrl: state.pageUrl }
      : {}),
  };
}

function writeStoredState(
  scope: OfficeDocumentScope,
  state: ChatState,
  storage: Storage | null = getDefaultLocalStorage(),
): boolean {
  if (!storage) {
    emitScopePersistFailed(scope, 'write', 'StorageUnavailable');
    return false;
  }
  try {
    if (!state.conversationId) {
      storage.removeItem(getStorageKey(scope));
      removeScopeFromIndex(scope, storage);
      return true;
    }

    storage.setItem(
      getStorageKey(scope),
      JSON.stringify({
        scope: {
          key: scope.key,
          mode: scope.mode,
          ...(scope.settingsId ? { settingsId: scope.settingsId } : {}),
          ...(scope.fingerprint ? { fingerprint: scope.fingerprint } : {}),
        },
        state,
      } satisfies ChatStateEnvelope),
    );
    rememberOfficeDocumentFingerprint(scope, storage);
    updateScopeIndex(scope, storage);
    return true;
  } catch (error) {
    emitScopePersistFailed(scope, 'write', error instanceof Error ? error.name : 'Error');
    return false;
  }
}

function getStorageKey(scope: OfficeDocumentScope): string {
  return `${CHAT_STATE_KEY_PREFIX}${encodeURIComponent(scope.key)}`;
}

function updateScopeIndex(
  scope: OfficeDocumentScope,
  storage: Storage | null = getDefaultLocalStorage(),
): void {
  if (!storage) {
    emitScopePersistFailed(scope, 'index', 'StorageUnavailable');
    return;
  }
  const storageKey = getStorageKey(scope);
  const index = readIndex(storage);
  index[storageKey] = {
    storageKey,
    scopeKeyHash: hashOfficeScopeKey(scope.key),
    mode: scope.mode,
    updatedAt: Date.now(),
  };
  const entries = Object.values(index).sort((left, right) => right.updatedAt - left.updatedAt);
  const staleEntries = entries.slice(MAX_SCOPED_CHAT_RECORDS);
  for (const entry of staleEntries) {
    delete index[entry.storageKey];
    try {
      storage.removeItem(entry.storageKey);
      emitScopePruned(scope, entry);
    } catch (error) {
      emitScopePersistFailed(scope, 'prune', error instanceof Error ? error.name : 'Error');
    }
  }
  if (!writeIndex(storage, index)) {
    emitScopePersistFailed(scope, 'index', 'WriteFailed');
  }
}

function removeScopeFromIndex(
  scope: OfficeDocumentScope,
  storage: Storage | null = getDefaultLocalStorage(),
): void {
  if (!storage) {
    emitScopePersistFailed(scope, 'index', 'StorageUnavailable');
    return;
  }
  const storageKey = getStorageKey(scope);
  const index = readIndex(storage);
  if (!index[storageKey]) return;
  delete index[storageKey];
  if (!writeIndex(storage, index)) {
    emitScopePersistFailed(scope, 'index', 'WriteFailed');
  }
}

function emitScopePersistFailed(
  scope: OfficeDocumentScope,
  operation: string,
  errorName?: string,
): void {
  console.warn('[rebel-addin-scope]', {
    code: 'scope_persist_failed',
    surface: 'office-addin',
    scopeMode: scope.mode,
    scopeKeyHash: hashOfficeScopeKey(scope.key),
    operation,
    ...(errorName ? { errorName } : {}),
  });
}

function emitScopePruned(scope: OfficeDocumentScope, entry: ChatStateIndexEntry): void {
  console.info('[rebel-addin-scope]', {
    code: 'scope_pruned',
    surface: 'office-addin',
    scopeMode: scope.mode,
    scopeKeyHash: hashOfficeScopeKey(scope.key),
    prunedScopeKeyHash: entry.scopeKeyHash,
  });
}

export function getChatState(scope: OfficeDocumentScope): ChatState {
  const envelope = readScopedEnvelope(scope);
  if (!envelope || envelope.scope.key !== scope.key) {
    return { ...EMPTY_CHAT_STATE };
  }
  rememberOfficeDocumentFingerprint(scope);
  return envelope.state;
}

export function setChatState(scope: OfficeDocumentScope, state: ChatState): void {
  writeStoredState(scope, {
    conversationId: state.conversationId,
    ...(typeof state.createdAt === 'number' && Number.isFinite(state.createdAt)
      ? { createdAt: state.createdAt }
      : {}),
    ...(typeof state.pageTitle === 'string' && state.pageTitle.length > 0
      ? { pageTitle: state.pageTitle }
      : {}),
    ...(typeof state.pageUrl === 'string' && state.pageUrl.length > 0
      ? { pageUrl: state.pageUrl }
      : {}),
  });
}

export function clearChatState(scope: OfficeDocumentScope): void {
  writeStoredState(scope, { conversationId: null });
}

export function getInitialSnapshot(scope: OfficeDocumentScope): PersistedChatState | null {
  return toPersistedState(getChatState(scope));
}

export function createOfficeScopedLocalStoragePersistence(
  scope: OfficeDocumentScope,
): ChatStatePersistence {
  rememberOfficeDocumentFingerprint(scope);

  return {
    async get(): Promise<PersistedChatState | null> {
      return getInitialSnapshot(scope);
    },

    async set(state: PersistedChatState): Promise<void> {
      setChatState(scope, {
        conversationId: state.conversationId,
        ...(typeof state.createdAt === 'number' && Number.isFinite(state.createdAt)
          ? { createdAt: state.createdAt }
          : {}),
        ...(typeof state.pageTitle === 'string' && state.pageTitle.length > 0
          ? { pageTitle: state.pageTitle }
          : {}),
        ...(typeof state.pageUrl === 'string' && state.pageUrl.length > 0
          ? { pageUrl: state.pageUrl }
          : {}),
      });
    },

    async clear(): Promise<void> {
      clearChatState(scope);
    },

    subscribe(onChange: () => void): () => void {
      if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
        return () => undefined;
      }

      const storageKey = getStorageKey(scope);
      const handleStorage = (event: StorageEvent): void => {
        if (event.key !== storageKey) return;
        onChange();
      };

      window.addEventListener('storage', handleStorage);
      return () => {
        window.removeEventListener('storage', handleStorage);
      };
    },
  };
}

export type CopyChatStateResult = 'copied' | 'missing-source' | 'target-exists' | 'write-failed';

export function copyChatStateBetweenScopesWithResult(
  fromScope: OfficeDocumentScope,
  toScope: OfficeDocumentScope,
  storage: Storage | null = getDefaultLocalStorage(),
): CopyChatStateResult {
  const envelope = readScopedEnvelope(fromScope, storage);
  if (!envelope?.state.conversationId) {
    return 'missing-source';
  }
  const existing = readScopedEnvelope(toScope, storage);
  if (existing?.state.conversationId) {
    return 'target-exists';
  }
  const written = writeStoredState(toScope, envelope.state, storage);
  if (!written) {
    return 'write-failed';
  }
  const copied = readScopedEnvelope(toScope, storage);
  return copied?.state.conversationId === envelope.state.conversationId ? 'copied' : 'write-failed';
}

export function copyChatStateBetweenScopes(
  fromScope: OfficeDocumentScope,
  toScope: OfficeDocumentScope,
  storage: Storage | null = getDefaultLocalStorage(),
): boolean {
  return copyChatStateBetweenScopesWithResult(fromScope, toScope, storage) === 'copied';
}

function getDefaultLocalStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}
