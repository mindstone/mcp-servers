import { ConnectorError, RETELL_API_BASE, REQUEST_TIMEOUT_MS } from './types.js';
import { envelopeApiErrorDetail } from './error-detail.js';

/** Mutable API key — set via configure_retell_api_key tool or RETELL_API_KEY env var. */
let apiKey = process.env.RETELL_API_KEY || '';

export function getApiKey(): string {
  return apiKey;
}

export function setApiKey(key: string): void {
  apiKey = key;
}

function getErrorResolution(status: number, detail?: string): string {
  const msg = (detail || '').toLowerCase();
  if (status === 401 || msg.includes('unauthorized') || msg.includes('invalid api key')) {
    return 'Authentication failed. Check your Retell AI API key. Get one at https://www.retellai.com/dashboard';
  }
  if (status === 402 || msg.includes('trial') || msg.includes('payment')) {
    return 'Payment required. Add a payment method at https://www.retellai.com/dashboard';
  }
  if (status === 403 || msg.includes('quota') || msg.includes('limit') || msg.includes('insufficient')) {
    return 'Insufficient permissions or quota exceeded. Check your plan at https://www.retellai.com/dashboard';
  }
  if (status === 404) {
    return 'Resource not found. The ID may be wrong, or the resource was deleted. Use list_agents, list_calls, list_retell_llms, or list_phone_numbers to browse available resources.';
  }
  if (status === 409) {
    return 'Conflict — the resource was modified concurrently. Retry the operation.';
  }
  if (status === 422 || msg.includes('validation')) {
    return 'Invalid request parameters. Check the input values and try again.';
  }
  if (status === 429) {
    return 'Rate limited. Wait a moment and try again.';
  }
  return 'Please try again. If the issue persists, check your API key and plan at https://www.retellai.com/dashboard';
}

/**
 * Ensure API key is configured, otherwise throw a setup guidance error.
 */
export function requireApiKey(): void {
  if (!apiKey) {
    throw new ConnectorError(
      'Retell AI API key not configured',
      'AUTH_REQUIRED',
      'Configure your Retell AI API key using the configure_retell_api_key tool. Get a key at https://www.retellai.com/dashboard',
    );
  }
}

/**
 * Make an authenticated API call to the Retell AI REST API.
 *
 * Bearer token auth, 30-second timeout, structured error handling.
 */
export async function retellFetch<T>(
  urlPath: string,
  options: RequestInit = {},
): Promise<T> {
  requireApiKey();

  const url = `${RETELL_API_BASE}${urlPath}`;
  // Multipart bodies (knowledge-base file uploads) must NOT carry a manual
  // Content-Type — fetch sets it with the correct boundary itself.
  const isMultipart = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${apiKey}`,
    ...(isMultipart ? {} : { 'Content-Type': 'application/json' }),
    ...(options.headers as Record<string, string> || {}),
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...options,
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      let detail = '';
      try {
        const errBody = await response.json() as { error_message?: string; detail?: string; message?: string };
        detail = errBody.error_message || errBody.detail || errBody.message || '';
      } catch { /* not JSON */ }

      throw new ConnectorError(
        `Retell AI API error (HTTP ${response.status}): ${detail ? envelopeApiErrorDetail(detail) : response.statusText}`,
        `HTTP_${response.status}`,
        getErrorResolution(response.status, detail),
      );
    }

    // Some endpoints return 204 No Content
    if (response.status === 204 || response.headers.get('content-length') === '0') {
      return {} as T;
    }

    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ConnectorError(
        'Request timed out after 30 seconds',
        'TIMEOUT',
        'The Retell AI API took too long to respond. Try again — if the issue persists, check https://status.retellai.com',
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
