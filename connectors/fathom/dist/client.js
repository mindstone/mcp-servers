/**
 * Fathom API HTTP client.
 *
 * Centralises X-Api-Key header injection, error handling, and rate-limit
 * messaging for all Fathom API calls.
 */
import { getApiKey } from './auth.js';
import { FathomError, FATHOM_API_BASE, REQUEST_TIMEOUT_MS } from './types.js';
/**
 * Make an authenticated request to the Fathom API.
 *
 * @param path  API path relative to base, e.g. `/meetings`
 * @param options  Additional fetch options
 * @returns Parsed JSON response
 */
export async function fathomFetch(path, options = {}) {
    const key = getApiKey();
    if (!key) {
        throw new FathomError('Fathom API key not configured', 'AUTH_REQUIRED', 'Use configure_fathom_api_key to set your API key first.');
    }
    const url = `${FATHOM_API_BASE}${path}`;
    let response;
    try {
        response = await fetch(url, {
            ...options,
            signal: options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            headers: {
                'X-Api-Key': key,
                'Content-Type': 'application/json',
                ...options.headers,
            },
        });
    }
    catch (error) {
        if (error instanceof Error && error.name === 'TimeoutError') {
            throw new FathomError('Request to Fathom API timed out', 'TIMEOUT', 'The request took too long. Try again or check if the Fathom API is available.');
        }
        throw error;
    }
    if (response.status === 401 || response.status === 403) {
        throw new FathomError('Authentication failed', 'AUTH_FAILED', 'Your Fathom API key is invalid or revoked. Use configure_fathom_api_key to set a new key.');
    }
    if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        const waitTime = retryAfter ? `${retryAfter} seconds` : 'a moment';
        throw new FathomError(`Rate limited by Fathom API. Please wait ${waitTime} before retrying.`, 'RATE_LIMITED', `Wait ${waitTime} and try again. Fathom limits API requests to 60 calls per minute.`);
    }
    if (response.status === 404) {
        throw new FathomError('Resource not found', 'NOT_FOUND', 'The requested resource does not exist or you do not have permission to access it.');
    }
    if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new FathomError(`Fathom API error (${response.status}): ${errorText}`, 'API_ERROR', 'Check the request parameters and try again.');
    }
    return response.json();
}
//# sourceMappingURL=client.js.map