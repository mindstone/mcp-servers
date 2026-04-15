/**
 * Humaans authentication module.
 *
 * Manages the API key lifecycle — env var on startup, runtime update via
 * configure tool, and bridge integration for host-app credential management.
 */
/**
 * Returns the current API key.
 */
export declare function getApiKey(): string;
/**
 * Returns true if an API key is configured.
 */
export declare function isConfigured(): boolean;
/**
 * Update the API key at runtime (e.g. after configure_humaans_api_key).
 */
export declare function setApiKey(key: string): void;
//# sourceMappingURL=auth.d.ts.map