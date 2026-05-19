import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  copyChatStateBetweenScopesWithResult,
  createOfficeScopedLocalStoragePersistence,
} from '../src/addin/chatState.js';
import type { OfficeDocumentScope } from '../src/addin/documentScope.js';

const CHAT_SCOPE_PREFIX = 'rebel.office.chat.scope.v1.';
const CHAT_SCOPE_INDEX_KEY = 'rebel.office.chat.scopes.v1';

function durableScope(id: number): OfficeDocumentScope {
  return {
    key: `office-durable:install:doc-scope-${id}`,
    mode: 'durable',
    host: 'word',
    settingsId: `doc-scope-${id}`,
    fingerprint: `fingerprint-${id}`,
  };
}

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.has(key) ? values.get(key) ?? null : null;
    },
    key(index: number) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

describe('office chatState bounded scoped records', () => {
  beforeEach(() => {
    (globalThis as typeof globalThis & { window?: { localStorage: Storage } }).window = {
      localStorage: createMemoryStorage(),
    };
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as typeof globalThis & { window?: { localStorage: Storage } }).window;
  });

  it('prunes the oldest scoped chat records once the cap is exceeded', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-25T12:00:00.000Z'));
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      for (let i = 0; i < 52; i += 1) {
        const persistence = createOfficeScopedLocalStoragePersistence(durableScope(i));
        await persistence.set({ conversationId: `conv-${i}` });
        vi.advanceTimersByTime(1);
      }

      const scopedKeys = Array.from({ length: window.localStorage.length }, (_, index) =>
        window.localStorage.key(index),
      ).filter((key): key is string => Boolean(key?.startsWith(CHAT_SCOPE_PREFIX)));
      expect(scopedKeys).toHaveLength(50);
      expect(
        window.localStorage.getItem(`${CHAT_SCOPE_PREFIX}${encodeURIComponent(durableScope(0).key)}`),
      ).toBeNull();
      expect(
        window.localStorage.getItem(`${CHAT_SCOPE_PREFIX}${encodeURIComponent(durableScope(51).key)}`),
      ).not.toBeNull();

      const rawIndex = window.localStorage.getItem(CHAT_SCOPE_INDEX_KEY);
      expect(rawIndex).not.toBeNull();
      const index = JSON.parse(rawIndex ?? '{}') as Record<string, unknown>;
      expect(Object.keys(index)).toHaveLength(50);
      expect(index).not.toHaveProperty(
        `${CHAT_SCOPE_PREFIX}${encodeURIComponent(durableScope(0).key)}`,
      );
      expect(infoSpy).toHaveBeenCalledWith(
        '[rebel-addin-scope]',
        expect.objectContaining({ code: 'scope_pruned' }),
      );
    } finally {
      infoSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('rebuilds a missing index before pruning scoped chat records', async () => {
    for (let i = 0; i < 52; i += 1) {
      const scope = durableScope(i);
      window.localStorage.setItem(
        `${CHAT_SCOPE_PREFIX}${encodeURIComponent(scope.key)}`,
        JSON.stringify({
          scope: {
            key: scope.key,
            mode: scope.mode,
            settingsId: scope.settingsId,
            fingerprint: scope.fingerprint,
          },
          state: {
            conversationId: `conv-${i}`,
            createdAt: i,
          },
        }),
      );
    }

    expect(window.localStorage.getItem(CHAT_SCOPE_INDEX_KEY)).toBeNull();

    const persistence = createOfficeScopedLocalStoragePersistence(durableScope(52));
    await persistence.set({ conversationId: 'conv-52', createdAt: 52 });

    const scopedKeys = Array.from({ length: window.localStorage.length }, (_, index) =>
      window.localStorage.key(index),
    ).filter((key): key is string => Boolean(key?.startsWith(CHAT_SCOPE_PREFIX)));
    expect(scopedKeys).toHaveLength(50);
    expect(
      window.localStorage.getItem(`${CHAT_SCOPE_PREFIX}${encodeURIComponent(durableScope(0).key)}`),
    ).toBeNull();
    expect(
      window.localStorage.getItem(`${CHAT_SCOPE_PREFIX}${encodeURIComponent(durableScope(52).key)}`),
    ).not.toBeNull();
  });

  it('isolates persistence between two distinct document scopes', async () => {
    const scopeA = durableScope(101);
    const scopeB = durableScope(102);
    const persistenceA = createOfficeScopedLocalStoragePersistence(scopeA);
    const persistenceB = createOfficeScopedLocalStoragePersistence(scopeB);

    await persistenceA.set({
      conversationId: 'conv-scope-a',
      createdAt: 101,
      pageTitle: 'Scope A.docx',
      pageUrl: 'file:///Scope%20A.docx',
    });

    await expect(persistenceB.get()).resolves.toBeNull();

    await persistenceB.set({
      conversationId: 'conv-scope-b',
      createdAt: 102,
      pageTitle: 'Scope B.docx',
      pageUrl: 'file:///Scope%20B.docx',
    });

    await expect(persistenceA.get()).resolves.toEqual({
      conversationId: 'conv-scope-a',
      createdAt: 101,
      pageTitle: 'Scope A.docx',
      pageUrl: 'file:///Scope%20A.docx',
    });
    await expect(persistenceB.get()).resolves.toEqual({
      conversationId: 'conv-scope-b',
      createdAt: 102,
      pageTitle: 'Scope B.docx',
      pageUrl: 'file:///Scope%20B.docx',
    });
  });

  it('gracefully recovers from a malformed scoped record by ignoring it and rebuilding the index', async () => {
    const corruptedScope = durableScope(201);
    const recoveredScope = durableScope(202);
    const corruptedStorageKey = `${CHAT_SCOPE_PREFIX}${encodeURIComponent(corruptedScope.key)}`;
    const recoveredStorageKey = `${CHAT_SCOPE_PREFIX}${encodeURIComponent(recoveredScope.key)}`;

    window.localStorage.setItem(corruptedStorageKey, '{not-valid-json');
    window.localStorage.setItem(CHAT_SCOPE_INDEX_KEY, '{not-valid-json');

    const corruptedPersistence = createOfficeScopedLocalStoragePersistence(corruptedScope);
    await expect(corruptedPersistence.get()).resolves.toBeNull();

    const recoveredPersistence = createOfficeScopedLocalStoragePersistence(recoveredScope);
    await recoveredPersistence.set({
      conversationId: 'conv-recovered',
      createdAt: 202,
    });

    const rawIndex = window.localStorage.getItem(CHAT_SCOPE_INDEX_KEY);
    expect(rawIndex).not.toBeNull();
    const index = JSON.parse(rawIndex ?? '{}') as Record<string, unknown>;
    expect(index).not.toHaveProperty(corruptedStorageKey);
    expect(index).toHaveProperty(recoveredStorageKey);
    await expect(recoveredPersistence.get()).resolves.toEqual({
      conversationId: 'conv-recovered',
      createdAt: 202,
    });
  });

  it('reports write-failed when migration cannot persist the target scope', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sourceScope = durableScope(1);
    const targetScope = durableScope(2);
    const storage = createMemoryStorage();
    storage.setItem(
      `${CHAT_SCOPE_PREFIX}${encodeURIComponent(sourceScope.key)}`,
      JSON.stringify({
        scope: {
          key: sourceScope.key,
          mode: sourceScope.mode,
          settingsId: sourceScope.settingsId,
          fingerprint: sourceScope.fingerprint,
        },
        state: {
          conversationId: 'conv-source',
        },
      }),
    );
    const failingStorage = {
      ...storage,
      setItem(key: string, value: string) {
        if (key.includes(encodeURIComponent(targetScope.key))) {
          throw new Error('quota');
        }
        storage.setItem(key, value);
      },
    } satisfies Storage;

    expect(
      copyChatStateBetweenScopesWithResult(sourceScope, targetScope, failingStorage),
    ).toBe('write-failed');
    expect(warnSpy).toHaveBeenCalledWith(
      '[rebel-addin-scope]',
      expect.objectContaining({
        code: 'scope_persist_failed',
        operation: 'write',
        errorName: 'Error',
      }),
    );
    warnSpy.mockRestore();
  });
});
