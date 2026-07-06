/**
 * Connector-specific configuration for the shared compose/send MCP-App iframe.
 *
 * Keep this surface minimal: every knob added here is a combination the
 * byte-parity and behavioural suites have to cover. Anything all email-shaped
 * connectors share (theming, view state machine, send lifecycle, host
 * protocol, migration shim) is baked into the template, not configurable.
 */
export interface ComposeFieldSpec {
  /** Render the CC row and its Add/Hide toggle. */
  cc: boolean;
  /**
   * Render the BCC row and its Add/Hide toggle. Set false for providers whose
   * send tool has no BCC parameter — a rendered field the tool would silently
   * drop is worse than no field.
   */
  bcc: boolean;
}

/**
 * Deep-link subsystem for the sent view, as a closed discriminator.
 * `'gmail'` inlines the Gmail "open the sent message" code verbatim
 * (URL construction stays in this package and the host re-validates via
 * `ui/open-external-link`); `'none'` omits the whole subsystem. This is
 * deliberately NOT a config-provided URL template: deep-link targets must
 * stay code-reviewed here, never string-assembled from connector config.
 */
export type ComposeDeepLink = { kind: 'gmail' } | { kind: 'none' };

/**
 * Escape hatch shown when the send tool is blocked (super-mcp TOOL_BLOCKED /
 * -33008 — user-disabled, admin-disabled, or security-policy). A closed
 * discriminator, not a config URL template: like {@link ComposeDeepLink}, the
 * target and URL construction stay code-reviewed in this package.
 * `'gmail-compose'` offers an "Open in Gmail" button that opens a prefilled
 * Gmail compose window (via the host `ui/open-external-link` bridge, which
 * re-validates against its own `mail.google.com` allowlist) — no tool call, so
 * it works even when every send/draft tool is disabled. `'none'` omits the
 * whole subsystem (default; the committed output is byte-identical to a config
 * without the field). Only meaningful for Gmail-backed connectors — other
 * providers whose compose host is not host-allowlisted must leave it `'none'`.
 */
export type ComposeBlockedSendFallback = { kind: 'gmail-compose' } | { kind: 'none' };

export interface ComposeAppConfig {
  /** `ui://` resource URI the connector serves this HTML under. */
  resourceUri: string;
  /** Tool the iframe invokes via `tools/call` when Send is clicked. */
  sendToolName: string;
  /**
   * Helper copy shown under From when the draft carries no confirmed sending
   * account (plain text; markup is rejected).
   */
  fromMissingHelperText: string;
  fields: ComposeFieldSpec;
  deepLink: ComposeDeepLink;
  /**
   * Optional. Omit (or set `{ kind: 'none' }`) to keep the historical output
   * byte-for-byte. See {@link ComposeBlockedSendFallback}.
   */
  blockedSendFallback?: ComposeBlockedSendFallback;
}
