/**
 * Fathom API HTTP client.
 *
 * Centralises X-Api-Key header injection, error handling, and rate-limit
 * messaging for all Fathom API calls.
 */
/**
 * Make an authenticated request to the Fathom API.
 *
 * @param path  API path relative to base, e.g. `/meetings`
 * @param options  Additional fetch options
 * @returns Parsed JSON response
 */
export declare function fathomFetch<T>(path: string, options?: RequestInit): Promise<T>;
//# sourceMappingURL=client.d.ts.map