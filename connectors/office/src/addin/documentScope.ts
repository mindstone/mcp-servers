import type { DocumentContext } from './chatClient.js';

const DOCUMENT_SCOPE_ID_SETTING_KEY = 'rebel.documentScopeId';
const INSTALL_SALT_STORAGE_KEY = 'rebel.office.installSalt.v1';

export interface OfficeDocumentScope {
  key: string;
  mode: 'durable' | 'ephemeral';
  host?: string;
  title?: string;
  url?: string;
  taskpaneSessionId?: string;
  settingsId?: string;
  fingerprint?: string;
}

export interface OfficeDocumentScopeResolution {
  scope: OfficeDocumentScope;
  sanitizedContext: DocumentContext;
  reason:
    | 'resolved-durable'
    | 'created-durable'
    | 'copy-diverged'
    | 'settings-save-failed'
    | 'settings-unavailable'
    | 'unsaved-document';
}

export interface OfficeDocumentSettingsLike {
  get(name: string): unknown;
  set(name: string, value: unknown): void;
  saveAsync(
    callback: (result: { status: string; error?: { name?: string; message?: string } }) => void,
  ): void;
}

export interface ResolveOfficeDocumentScopeOptions {
  documentContext: DocumentContext;
  taskpaneSessionId: string;
  settings?: OfficeDocumentSettingsLike | null;
  storage?: Storage | null;
  createOpaqueId?: () => string;
  log?: (entry: Record<string, unknown>) => void;
}

interface PersistDocumentScopeIdResult {
  saved: boolean;
  errorName?: string;
}

export function createOfficeTaskpaneSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `office-taskpane-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function deriveDocumentLabel(host?: string): 'Document' | 'Workbook' | 'Presentation' {
  switch (host) {
    case 'excel':
      return 'Workbook';
    case 'powerpoint':
      return 'Presentation';
    default:
      return 'Document';
  }
}

export async function resolveOfficeDocumentScope(
  options: ResolveOfficeDocumentScopeOptions,
): Promise<OfficeDocumentScopeResolution> {
  const storage = options.storage ?? getDefaultLocalStorage();
  const sanitizedContext = sanitizeDocumentContext(options.documentContext);
  const installSalt = ensureInstallSalt(storage, options.createOpaqueId);
  const fingerprint = createDocumentFingerprint(sanitizedContext);
  const settings = options.settings ?? null;
  const existingSettingsId = readDocumentScopeId(settings);

  if (existingSettingsId) {
    const previousFingerprint = readStoredFingerprint(storage, existingSettingsId);
    if (fingerprint && previousFingerprint && previousFingerprint !== fingerprint) {
      const replacementId = createOpaqueId(options.createOpaqueId);
      const saveResult = await persistDocumentScopeId(settings, replacementId);
      if (saveResult.saved) {
        const scope = createDurableScope({
          installSalt,
          settingsId: replacementId,
          fingerprint,
          context: sanitizedContext,
        });
        emitResolutionLog(options.log, 'scope_mismatch_discarded', scope, {
          previousScopeKeyHash: hashOfficeScopeKey(`office-durable:${installSalt}:${existingSettingsId}`),
          reason: 'document-copy-diverged',
        });
        return {
          scope,
          sanitizedContext,
          reason: 'copy-diverged',
        };
      }

      return emitEphemeralResolution(
        options,
        installSalt,
        sanitizedContext,
        fingerprint,
        'settings-save-failed',
        saveResult.errorName ? { errorName: saveResult.errorName } : {},
      );
    }

    if (fingerprint && !previousFingerprint) {
      const replacementId = createOpaqueId(options.createOpaqueId);
      const saveResult = await persistDocumentScopeId(settings, replacementId);
      if (saveResult.saved) {
        const scope = createDurableScope({
          installSalt,
          settingsId: replacementId,
          fingerprint,
          context: sanitizedContext,
        });
        emitResolutionLog(options.log, 'scope_mismatch_discarded', scope, {
          previousScopeKeyHash: hashOfficeScopeKey(`office-durable:${installSalt}:${existingSettingsId}`),
          reason: 'missing-stored-fingerprint',
        });
        return {
          scope,
          sanitizedContext,
          reason: 'copy-diverged',
        };
      }

      return emitEphemeralResolution(
        options,
        installSalt,
        sanitizedContext,
        fingerprint,
        'settings-save-failed',
        saveResult.errorName ? { errorName: saveResult.errorName } : {},
      );
    }

    const scope = createDurableScope({
      installSalt,
      settingsId: existingSettingsId,
      ...(fingerprint ? { fingerprint } : {}),
      context: sanitizedContext,
    });
    emitResolutionLog(options.log, 'scope_resolved', scope);
    return {
      scope,
      sanitizedContext,
      reason: 'resolved-durable',
    };
  }

  if (!fingerprint) {
    return emitEphemeralResolution(options, installSalt, sanitizedContext, fingerprint, 'unsaved-document');
  }

  if (!settings) {
    return emitEphemeralResolution(options, installSalt, sanitizedContext, fingerprint, 'settings-unavailable');
  }

  const nextSettingsId = createOpaqueId(options.createOpaqueId);
  const saveResult = await persistDocumentScopeId(settings, nextSettingsId);
  if (!saveResult.saved) {
    return emitEphemeralResolution(
      options,
      installSalt,
      sanitizedContext,
      fingerprint,
      'settings-save-failed',
      saveResult.errorName ? { errorName: saveResult.errorName } : {},
    );
  }

  const scope = createDurableScope({
    installSalt,
    settingsId: nextSettingsId,
    fingerprint,
    context: sanitizedContext,
  });
  emitResolutionLog(options.log, 'scope_resolved', scope);
  return {
    scope,
    sanitizedContext,
    reason: 'created-durable',
  };
}

function emitEphemeralResolution(
  options: ResolveOfficeDocumentScopeOptions,
  installSalt: string,
  sanitizedContext: DocumentContext,
  fingerprint: string | undefined,
  reason: OfficeDocumentScopeResolution['reason'],
  extra: Record<string, unknown> = {},
): OfficeDocumentScopeResolution {
  const scope = createEphemeralScope({
    installSalt,
    taskpaneSessionId: options.taskpaneSessionId,
    fingerprint,
    context: sanitizedContext,
  });
  emitResolutionLog(options.log, 'scope_fallback_ephemeral', scope, { reason, ...extra });
  return {
    scope,
    sanitizedContext,
    reason,
  };
}

function createDurableScope(params: {
  installSalt: string;
  settingsId: string;
  fingerprint?: string;
  context: DocumentContext;
}): OfficeDocumentScope {
  return {
    key: `office-durable:${params.installSalt}:${params.settingsId}`,
    mode: 'durable',
    ...(params.context.host ? { host: params.context.host } : {}),
    ...(params.context.title ? { title: params.context.title } : {}),
    ...(params.context.url ? { url: params.context.url } : {}),
    settingsId: params.settingsId,
    ...(params.fingerprint ? { fingerprint: params.fingerprint } : {}),
  };
}

function createEphemeralScope(params: {
  installSalt: string;
  taskpaneSessionId: string;
  fingerprint?: string;
  context: DocumentContext;
}): OfficeDocumentScope {
  return {
    key: `office-ephemeral:${params.installSalt}:${params.taskpaneSessionId}`,
    mode: 'ephemeral',
    ...(params.context.host ? { host: params.context.host } : {}),
    ...(params.context.title ? { title: params.context.title } : {}),
    ...(params.context.url ? { url: params.context.url } : {}),
    taskpaneSessionId: params.taskpaneSessionId,
    ...(params.fingerprint ? { fingerprint: params.fingerprint } : {}),
  };
}

function sanitizeDocumentContext(context: DocumentContext): DocumentContext {
  const sanitizedUrl = typeof context.url === 'string' && context.url.length > 0
    ? normalizeDocumentUrl(context.url)
    : undefined;
  return {
    ...(context.host ? { host: context.host } : {}),
    ...(context.title ? { title: context.title } : {}),
    ...(sanitizedUrl ? { url: sanitizedUrl } : {}),
  };
}

function normalizeDocumentUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url.split('?')[0]?.split('#')[0] ?? url;
  }
}

export function createDocumentFingerprint(context: DocumentContext): string | undefined {
  if (!context.url) {
    return undefined;
  }
  return hashText([
    context.host ?? '',
    context.title ?? '',
    context.url,
  ].join('|'));
}

function readDocumentScopeId(settings: OfficeDocumentSettingsLike | null): string | null {
  try {
    const raw = settings?.get(DOCUMENT_SCOPE_ID_SETTING_KEY);
    return typeof raw === 'string' && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

function ensureInstallSalt(
  storage: Storage | null,
  createOpaqueIdOverride?: () => string,
): string {
  try {
    const existing = storage?.getItem(INSTALL_SALT_STORAGE_KEY);
    if (existing && existing.length > 0) {
      return existing;
    }
  } catch {
    // localStorage can be unavailable in locked-down Office hosts.
  }
  const next = createOpaqueId(createOpaqueIdOverride);
  try {
    storage?.setItem(INSTALL_SALT_STORAGE_KEY, next);
  } catch {
    // localStorage is best effort here.
  }
  return next;
}

function readStoredFingerprint(storage: Storage | null, settingsId: string): string | null {
  try {
    const raw = storage?.getItem(getFingerprintStorageKey(settingsId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { fingerprint?: unknown } | null;
    return typeof parsed?.fingerprint === 'string' && parsed.fingerprint.length > 0
      ? parsed.fingerprint
      : null;
  } catch {
    return null;
  }
}

export function rememberOfficeDocumentFingerprint(
  scope: OfficeDocumentScope,
  storage: Storage | null = getDefaultLocalStorage(),
): void {
  if (scope.mode !== 'durable' || !scope.settingsId || !scope.fingerprint) {
    return;
  }
  try {
    storage?.setItem(
      getFingerprintStorageKey(scope.settingsId),
      JSON.stringify({ fingerprint: scope.fingerprint }),
    );
  } catch {
    // localStorage is best effort here.
  }
}

function getFingerprintStorageKey(settingsId: string): string {
  return `rebel.office.documentFingerprint.v1.${settingsId}`;
}

function createOpaqueId(createOpaqueIdOverride?: () => string): string {
  if (createOpaqueIdOverride) {
    return createOpaqueIdOverride();
  }
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `office-scope-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function persistDocumentScopeId(
  settings: OfficeDocumentSettingsLike | null,
  documentScopeId: string,
): Promise<PersistDocumentScopeIdResult> {
  if (!settings) return { saved: false, errorName: 'SettingsUnavailable' };
  try {
    settings.set(DOCUMENT_SCOPE_ID_SETTING_KEY, documentScopeId);
    return await new Promise<PersistDocumentScopeIdResult>((resolve) => {
      settings.saveAsync((result) => {
        resolve(
          result.status === 'succeeded'
            ? { saved: true }
            : { saved: false, errorName: result.error?.name ?? 'SettingsSaveFailed' },
        );
      });
    });
  } catch (error) {
    return {
      saved: false,
      errorName: error instanceof Error ? error.name : 'Error',
    };
  }
}

function emitResolutionLog(
  log: ResolveOfficeDocumentScopeOptions['log'],
  code: 'scope_resolved' | 'scope_fallback_ephemeral' | 'scope_mismatch_discarded',
  scope: OfficeDocumentScope,
  extra: Record<string, unknown> = {},
): void {
  log?.({
    code,
    surface: 'office-addin',
    scopeMode: scope.mode,
    scopeKeyHash: hashOfficeScopeKey(scope.key),
    ...(scope.fingerprint ? { fingerprint: scope.fingerprint } : {}),
    ...extra,
  });
}

export function hashOfficeScopeKey(value: string): string {
  return hashText(value);
}

function getDefaultLocalStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function hashText(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}
