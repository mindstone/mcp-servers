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
}
