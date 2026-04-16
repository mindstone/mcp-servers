/**
 * Fathom authentication module.
 *
 * Manages the API key lifecycle — env var on startup, runtime update via
 * configure tool, and bridge integration for host-app credential management.
 */
let apiKey = process.env.FATHOM_API_KEY || '';
/**
 * Returns the current API key.
 */
export function getApiKey() {
    return apiKey;
}
/**
 * Returns true if an API key is configured.
 */
export function isConfigured() {
    return apiKey.length > 0;
}
/**
 * Update the API key at runtime (e.g. after configure_fathom_api_key).
 */
export function setApiKey(key) {
    apiKey = key;
}
//# sourceMappingURL=auth.js.map