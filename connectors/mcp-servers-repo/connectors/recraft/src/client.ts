import { getApiKey } from './auth.js';
import { RECRAFT_API_BASE, REQUEST_TIMEOUT_MS, RecraftError } from './types.js';

export async function recraftFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const key = getApiKey();
  if (!key) {
    throw new RecraftError(
      'Recraft API key not configured',
      'AUTH_REQUIRED',
      'Use configure_recraft_api_key to set your API key first.',
    );
  }

  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${key}`);
  if (!(options.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  let response: Response;
  try {
    response = await fetch(`${RECRAFT_API_BASE}${path}`, {
      ...options,
      signal: options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new RecraftError(
        'Request to Recraft API timed out',
        'TIMEOUT',
        'The request took too long. Try again.',
      );
    }
    throw error;
  }

  if (response.status === 401 || response.status === 403) {
    throw new RecraftError(
      'Authentication failed',
      'AUTH_FAILED',
      'Your Recraft API key is invalid or expired. Use configure_recraft_api_key to set a new key.',
    );
  }

  if (response.status === 429) {
    throw new RecraftError(
      'Rate limited by Recraft API',
      'RATE_LIMITED',
      'Wait a moment and try again.',
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => 'Unknown error');
    throw new RecraftError(
      `Recraft API error (${response.status}): ${text}`,
      'API_ERROR',
      'Check the request parameters and try again.',
    );
  }

  const ct = response.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    return response.json() as Promise<T>;
  }

  return (await response.text()) as T;
}
