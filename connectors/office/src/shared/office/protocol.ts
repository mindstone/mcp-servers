/**
 * Office sidecar protocol adapter — Stage 8.
 *
 * Thin re-export layer over `@core/appBridge/shared/protocol`. We keep:
 *   - `OfficeApp` narrowing (`'word' | 'excel' | 'powerpoint'`) and
 *     `isOfficeApp()` runtime guard — the Office sidecar only ever talks to
 *     one of those three Office hosts.
 *   - `LegacyOfficeRegisterMessage` — the register shape Office's in-the-wild
 *     add-in sends today: `{ type: 'register', app: 'word', version: '1.0.0' }`.
 *   - `adaptLegacyRegisterMessage()` — upgrades the legacy shape to the
 *     core-compatible shape (`{ type: 'register', appId: 'office-word', ... }`)
 *     so the sidecar can forward it to the shared `ConnectionManager`.
 *
 * R26 (backward-compatibility): the Office add-in ships separately from
 * Rebel and is in the wild; the sidecar MUST continue to accept the legacy
 * register shape even after Stage 8 lands.
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md
 */

import type {
  AuthMessage,
  CapabilityDescriptor,
  CommandMessage,
  PingMessage,
  PongMessage,
  RegisterMessage as CoreRegisterMessage,
  ResponseErrorMessage,
  ResponseMessage,
  ResponseSuccessMessage,
} from '../appBridge/shared/protocol.js';

// ---------------------------------------------------------------------------
// Core wire types — re-exported so Office callers keep a single import site.
// ---------------------------------------------------------------------------

export type {
  AuthMessage,
  CommandMessage,
  PingMessage,
  PongMessage,
  ResponseErrorMessage,
  ResponseMessage,
  ResponseSuccessMessage,
};

// ---------------------------------------------------------------------------
// Office-specific narrowings
// ---------------------------------------------------------------------------

/** Office hosts the sidecar knows about. Used as the external wire identity. */
export const OFFICE_APPS = ['word', 'excel', 'powerpoint'] as const;
export type OfficeApp = (typeof OFFICE_APPS)[number];

/**
 * Internal `appId` used by the shared `ConnectionManager`. Prefix avoids
 * namespace collisions with other bridged apps (e.g. `'browser-extension'`).
 * HTTP routes (`/word/*`, `/excel/*`, `/powerpoint/*`) and the
 * legacy register shape still use the bare `OfficeApp` identifier; this
 * mapping is internal to the sidecar.
 */
export type OfficeAppId = `office-${OfficeApp}`;

const APP_SET: ReadonlySet<string> = new Set<string>(OFFICE_APPS);

export function isOfficeApp(value: unknown): value is OfficeApp {
  return typeof value === 'string' && APP_SET.has(value);
}

export function toOfficeAppId(app: OfficeApp): OfficeAppId {
  return `office-${app}` satisfies OfficeAppId;
}

// ---------------------------------------------------------------------------
// Register message — legacy + upgraded shape
// ---------------------------------------------------------------------------

/**
 * Register shape the shipped Office add-in sends today. Preserved for
 * backwards compatibility so old add-in builds keep working after Stage 8.
 */
export interface LegacyOfficeRegisterMessage {
  type: 'register';
  app: OfficeApp;
  version: string;
}

/**
 * Core-compatible register shape, narrowed to Office's `appId` namespace.
 * The `appId` is always `'office-<app>'` so the shared `ConnectionManager`
 * can route by the same key schema used for other bridged apps.
 */
export interface OfficeRegisterMessage {
  type: 'register';
  appId: OfficeAppId;
  protocolVersion?: string;
  appVersion?: string;
  clientId?: string;
  capabilities?: readonly CapabilityDescriptor[];
}

/**
 * Either register shape is accepted on the wire; the sidecar upgrades
 * legacy messages via {@link adaptLegacyRegisterMessage} before passing to
 * the shared `ConnectionManager`.
 */
export type RegisterMessage = LegacyOfficeRegisterMessage | OfficeRegisterMessage;

/** Runtime guard: distinguishes the legacy shape from the upgraded shape. */
export function isLegacyOfficeRegisterMessage(
  msg: RegisterMessage,
): msg is LegacyOfficeRegisterMessage {
  return 'app' in msg && !('appId' in msg);
}

/**
 * Upgrade a legacy `{ type: 'register', app, version }` message to the
 * core-compatible `{ type: 'register', appId, protocolVersion, appVersion,
 * capabilities }` shape.
 *
 * Default `protocolVersion` is `'1.0'` (current wire version). `capabilities`
 * defaults to `[]` because Office's capability discovery is action-level
 * (HTTP path routing) rather than register-time advertised — the shared
 * `CapabilityRegistry` isn't wired into Office's tool surface.
 */
export function adaptLegacyRegisterMessage(
  msg: LegacyOfficeRegisterMessage,
): OfficeRegisterMessage {
  return {
    type: 'register',
    appId: toOfficeAppId(msg.app),
    protocolVersion: '1.0',
    appVersion: msg.version,
    capabilities: [],
  };
}

/**
 * Normalise any accepted register shape to the core-compatible form. Pure
 * utility — callers can forward the result straight into the shared
 * `ConnectionManager.register({ appId, clientId, protocolVersion, ... })`
 * constructor.
 */
export function normaliseRegisterMessage(
  msg: RegisterMessage,
): OfficeRegisterMessage {
  return isLegacyOfficeRegisterMessage(msg) ? adaptLegacyRegisterMessage(msg) : msg;
}

/**
 * Validate an inbound WS message that claims to be `type: 'register'`. Returns
 * the upgraded Office-shaped register message, or `null` if the payload is
 * neither a valid legacy `{ type, app, version }` message nor a valid
 * upgraded `{ type, appId, ... }` message. The sidecar's WS handler calls
 * this at the auth boundary; callers that pass back `null` should close the
 * socket with `4002 Invalid message`.
 */
export function validateRegisterMessage(
  raw: unknown,
): OfficeRegisterMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const msg = raw as Record<string, unknown>;
  if (msg.type !== 'register') return null;

  // Legacy shape: `{ type, app, version }` (what the shipped add-in sends).
  if (typeof msg.app === 'string' && isOfficeApp(msg.app)) {
    if (typeof msg.version !== 'string' || msg.version.trim().length === 0) {
      return null;
    }
    return adaptLegacyRegisterMessage({
      type: 'register',
      app: msg.app,
      version: msg.version,
    });
  }

  // Upgraded shape: `{ type, appId: 'office-<app>', ... }`.
  if (typeof msg.appId === 'string' && msg.appId.startsWith('office-')) {
    const bare = msg.appId.slice('office-'.length);
    if (!isOfficeApp(bare)) return null;

    const normalised: OfficeRegisterMessage = {
      type: 'register',
      appId: msg.appId as OfficeAppId,
    };
    if (typeof msg.protocolVersion === 'string') {
      normalised.protocolVersion = msg.protocolVersion;
    }
    if (typeof msg.appVersion === 'string') {
      normalised.appVersion = msg.appVersion;
    }
    if (typeof msg.clientId === 'string') {
      normalised.clientId = msg.clientId;
    }
    if (Array.isArray(msg.capabilities)) {
      normalised.capabilities = msg.capabilities as readonly CapabilityDescriptor[];
    }
    return normalised;
  }

  return null;
}

/** Bare `OfficeApp` back out of an `OfficeAppId`, e.g. `'office-word'` → `'word'`. */
export function fromOfficeAppId(appId: OfficeAppId): OfficeApp {
  return appId.slice('office-'.length) as OfficeApp;
}

// ---------------------------------------------------------------------------
// Union types — preserved for backwards compatibility with existing imports
// ---------------------------------------------------------------------------

export type AddinToSidecarMessage =
  | AuthMessage
  | RegisterMessage
  | ResponseMessage
  | PingMessage
  | PongMessage;

export type SidecarToAddinMessage = CommandMessage | PingMessage | PongMessage;

// ---------------------------------------------------------------------------
// Re-export the core RegisterMessage for callers that want the superset shape
// ---------------------------------------------------------------------------

export type { CoreRegisterMessage };
