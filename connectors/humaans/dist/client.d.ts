/**
 * Humaans API HTTP client.
 *
 * Centralises Bearer auth header injection, error handling, rate-limit
 * messaging, and timeout handling for all Humaans API calls.
 */
/**
 * Make an authenticated request to the Humaans API.
 *
 * @param path  API path relative to base, e.g. `/people`
 * @param options  Additional fetch options
 * @returns Parsed JSON response
 */
export declare function humaansFetch<T>(path: string, options?: RequestInit): Promise<T>;
//# sourceMappingURL=client.d.ts.map