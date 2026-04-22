/**
 * Rebel App Bridge — shared protocol types.
 *
 * Message schemas flowing between apps (browser extension, Office add-in,
 * desktop apps, etc.) and the Rebel App Bridge. Must stay backwards compatible
 * with Office's existing register shape (`{ type: 'register', app, version }`)
 * because Office reuses these primitives from Stage 8 onward.
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md
 */

// ---------------------------------------------------------------------------
// Capability keys (Stage 4 — R27 / D27 consistency check)
// ---------------------------------------------------------------------------

/**
 * Canonical capability identifiers the bridge understands today.
 *
 * This is the single source of truth used by:
 *   - `TOOLS_BY_APP_ID` (resources/mcp/rebel-app-bridge/tools/index.js) —
 *     every tool must declare exactly one of these as its capability.
 *   - `CAPABILITY_BY_TOOL_NAME` — same mapping inverted for the relay.
 *   - `scripts/check-app-bridge-tool-registry.ts` — validates the two
 *     registries agree and that every capability referenced exists here.
 *
 * Adding a new capability means: append to this tuple, add a tool in
 * `resources/mcp/rebel-app-bridge/tools/browser.js`, register the extension
 * side, and update docs. The consistency check fails loud if any of those
 * drift out of sync.
 */
export const CAPABILITY_KEYS = [
  'read_page',
  'get_selection',
  'get_current_tab_url',
  'fill_form',
  'click',
  'scroll',
  'status',
] as const;

/**
 * Host-only capabilities that the MCP server handles in-process.
 * These are never relayed to a paired app.
 */
export const HOST_CAPABILITY_KEYS = [
  'list_browsers',
] as const;

export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];
export type HostCapabilityKey = (typeof HOST_CAPABILITY_KEYS)[number];

/** Runtime guard — useful at HTTP/stdio boundaries. */
export function isCapabilityKey(value: unknown): value is CapabilityKey {
  return (
    typeof value === 'string' &&
    (CAPABILITY_KEYS as readonly string[]).includes(value)
  );
}

export function isHostCapabilityKey(value: unknown): value is HostCapabilityKey {
  return (
    typeof value === 'string' &&
    (HOST_CAPABILITY_KEYS as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// App identifiers
// ---------------------------------------------------------------------------

/**
 * Opaque app identifier. Stage 1 only advertises `'browser-extension'`, but
 * the bridge is built to host arbitrary apps (Office family, future surfaces).
 *
 * The `string & {}` suffix keeps literal-type hints in IDEs while accepting
 * any non-empty string at runtime — validate at the boundary via `isAppType`.
 */
export type AppType = KnownAppType | (string & {});

export type KnownAppType = 'browser-extension';

/** Runtime guard — accepts any non-empty string. */
export function isAppType(value: unknown): value is AppType {
  return typeof value === 'string' && value.length > 0;
}

// ---------------------------------------------------------------------------
// Capability descriptor
// ---------------------------------------------------------------------------

/**
 * Capability advertised by an app during registration.
 *
 * `inputSchema` is typed as `unknown` intentionally: the shared layer holds a
 * JSONSchema-Draft-7 object but does not depend on zod or ajv. Consumers
 * (wsServer, capabilityRegistry) validate at their own boundary.
 */
export interface CapabilityDescriptor {
  id: string;
  description?: string;
  inputSchema?: unknown;
}

// ---------------------------------------------------------------------------
// App → Bridge messages
// ---------------------------------------------------------------------------

export interface AuthMessage {
  type: 'auth';
  token: string;
  /**
   * App identifier claimed by the authenticating client. Stage 3's WS
   * validator requires this for the new bridge; Office's legacy sidecar
   * omits it (its token is single-purpose, so the token itself is scope).
   */
  appId?: AppType;
  /**
   * Per-install identifier the caller was issued at pairing time. Stage 3's
   * WS validator requires this to match the token's claims (R6).
   */
  clientId?: string;
  /**
   * Post-review B4 — extension origin fingerprint carried from pair-claim
   * time. `tokenStore.verifyAppToken` requires the caller to present the
   * same fingerprint that was bound into the token's claims. `null` /
   * absent is accepted for legacy callers (Office).
   */
  fingerprint?: string | null;
}

/**
 * Register message.
 *
 * `protocolVersion`, `appVersion`, `clientId`, and `capabilities` are all
 * optional so Office's existing sidecar register payload
 * (`{ type: 'register', app: 'word', version: '1.0.0' }`) remains valid.
 * Missing `protocolVersion` is treated as `'1.0'` by the server.
 */
export interface RegisterMessage {
  type: 'register';
  appId: AppType;
  protocolVersion?: string;
  appVersion?: string;
  clientId?: string;
  capabilities?: CapabilityDescriptor[];
}

export interface ResponseSuccessMessage {
  type: 'response';
  id: string;
  success: true;
  data: unknown;
}

export interface ResponseErrorMessage {
  type: 'response';
  id: string;
  success: false;
  error: string;
  code?: string;
}

export type ResponseMessage = ResponseSuccessMessage | ResponseErrorMessage;

export interface PingMessage {
  type: 'ping';
}

export interface PongMessage {
  type: 'pong';
}

// ---------------------------------------------------------------------------
// Bridge → App messages
// ---------------------------------------------------------------------------

export interface RegisteredAck {
  type: 'registered';
  sessionId: string;
  acceptedCapabilities: string[];
  serverProtocolVersion: '1.0';
  minClientProtocolVersion: '1.0';
}

/**
 * Browser tab identity propagated from the agent / intent surface down to the
 * extension at execution time (R18 / D21). The extension validates that the
 * target tab still exists before invoking DOM handlers; if the tab has closed
 * or navigated, it returns `TAB_CONTEXT_GONE` rather than silently retargeting
 * whichever tab happens to be active now.
 *
 * All fields are optional so pre-6c callers (and the `status` capability) keep
 * working — the bridge-side validator enforces required-ness per-capability.
 */
export interface TabContext {
  tabId?: number;
  windowId?: number;
  url?: string;
  title?: string;
}

export interface CommandMessage {
  type: 'command';
  id: string;
  /** Previous commandId when retrying — lets the app skip already-executed work (R19/D22). */
  prevCommandId?: string;
  action: string;
  params: Record<string, unknown>;
  /** Target browser tab for DOM commands (R18 / D21). Omitted for status/intent routes. */
  tabContext?: TabContext;
}

export interface ErrorMessage {
  type: 'error';
  code: string;
  message: string;
  /** Correlation id for a failed command, when applicable. */
  commandId?: string;
  /**
   * Previous commandId when the error relates to an idempotent-drop of a
   * retry (R19 / D22). Populated when the bridge refuses a retry because the
   * original command was executed after a late response arrived.
   */
  prevCommandId?: string;
}

// ---------------------------------------------------------------------------
// Union types
// ---------------------------------------------------------------------------

export type AppToBridgeMessage =
  | AuthMessage
  | RegisterMessage
  | ResponseMessage
  | PingMessage
  | PongMessage;

export type BridgeToAppMessage =
  | RegisteredAck
  | CommandMessage
  | PingMessage
  | PongMessage
  | ErrorMessage;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default bridge port, off the Office sidecar's 52100 range per R1. */
export const DEFAULT_APP_BRIDGE_PORT = 52320;

/**
 * Port-fallback list on `EADDRINUSE` (e.g. dev + prod Rebel instance on the
 * same machine per R30). Ordered preference.
 */
export const APP_BRIDGE_PORT_FALLBACKS: readonly number[] = [
  52320,
  52321,
  52322,
  52323,
  52324,
  52325,
];

/** WebSocket upgrade path on the bridge HTTP server. */
export const WS_PATH = '/ws';

/** Current wire protocol version. Bumped when a breaking change is required. */
export const PROTOCOL_VERSION = '1.0';

// ---------------------------------------------------------------------------
// WebSocket close codes (Stage 3)
// ---------------------------------------------------------------------------

/**
 * Explicit WS close codes used by the bridge. Mirrors the mapping in
 * `toWsCloseCode(ErrorCode)` but is exported as named constants so the
 * wsServer, tests, and clients can reference semantic names.
 *
 * Range 4000–4999 is reserved for application-defined codes per RFC 6455.
 */
export const WS_CLOSE_NORMAL = 1000;
export const WS_CLOSE_GOING_AWAY = 1001;
export const WS_CLOSE_UNAUTHORIZED = 4001;
export const WS_CLOSE_INVALID_MESSAGE = 4002;
export const WS_CLOSE_SUPERSEDED = 4003;
export const WS_CLOSE_PROTOCOL_VERSION_MISMATCH = 4010;
export const WS_CLOSE_IDLE_TIMEOUT = 4011;
