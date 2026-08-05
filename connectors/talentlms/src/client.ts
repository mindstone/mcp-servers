/**
 * TalentLMS API HTTP client.
 *
 * Centralises Basic auth injection (base64(apiKey:) with colon preserved, empty password),
 * error handling, rate-limit messaging, and timeout handling.
 *
 * Base URL: https://{domain}.talentlms.com/api/v1
 */

import { z } from 'zod';
import { TalentLMSError, REQUEST_TIMEOUT_MS } from './types.js';
import { getApiKey, getDomain, isConfigured } from './auth.js';
import { wrapUntrusted } from './untrusted-content.js';

/** Shape of the TalentLMS error payload, validated at the boundary. */
const apiErrorBodySchema = z
  .object({
    error: z
      .object({
        message: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/** Vendor error text is truncated before enveloping — it is diagnostic, not prose. */
const MAX_VENDOR_ERROR_MESSAGE_CHARS = 500;

/**
 * Extract the vendor's error message from an error response, or null when the
 * body carries none. The message is untrusted external content (invariant #6):
 * callers must envelope it before it reaches model-visible output. The raw
 * body is never returned — it can reflect submitted values (including
 * passwords from create/update user calls) back into model output.
 */
async function readVendorErrorMessage(response: Response): Promise<string | null> {
  try {
    const parsed = apiErrorBodySchema.safeParse(await response.json());
    const message = parsed.success ? parsed.data.error?.message : undefined;
    if (!message) return null;
    return message.length > MAX_VENDOR_ERROR_MESSAGE_CHARS
      ? message.slice(0, MAX_VENDOR_ERROR_MESSAGE_CHARS)
      : message;
  } catch {
    return null;
  }
}

function getBaseUrl(): string {
  return `https://${getDomain()}.talentlms.com/api/v1`;
}

/**
 * Make an authenticated request to the TalentLMS API.
 */
export async function talentlmsFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  if (!isConfigured()) {
    throw new TalentLMSError(
      'TalentLMS not configured',
      'AUTH_REQUIRED',
      'Configure your TalentLMS API key and domain. Call configure_talentlms first.',
    );
  }

  const apiKey = getApiKey();
  const url = `${getBaseUrl()}${path}`;

  const authHeader = 'Basic ' + Buffer.from(`${apiKey}:`).toString('base64');
  const headers: Record<string, string> = {
    Authorization: authHeader,
    ...(options.headers as Record<string, string> || {}),
  };
  if (options.body) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }

  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      signal: options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new TalentLMSError(
        'Request to TalentLMS API timed out',
        'TIMEOUT',
        'The request took too long. Try again or check if TalentLMS is available.',
      );
    }
    throw error;
  }

  if (response.status === 429) {
    throw new TalentLMSError(
      'Rate limited by TalentLMS. Please wait before retrying.',
      'RATE_LIMITED',
      'TalentLMS rate limits depend on your subscription plan (no fixed public figures) and include a short-window burst cap. Wait a moment before retrying, and pace bulk operations.',
    );
  }

  if (response.status === 401 || response.status === 403) {
    const vendorMessage = await readVendorErrorMessage(response);
    const detail = vendorMessage ? `: ${wrapUntrusted(vendorMessage, 'talentlms:api-error')}` : '';
    throw new TalentLMSError(
      `Authentication failed${detail}`,
      'AUTH_FAILED',
      'Re-configure with configure_talentlms. Ensure Super Admin API access is enabled.',
    );
  }

  if (!response.ok) {
    const vendorMessage = await readVendorErrorMessage(response);
    const detail = vendorMessage ? `: ${wrapUntrusted(vendorMessage, 'talentlms:api-error')}` : '';
    throw new TalentLMSError(
      `TalentLMS API error (${response.status})${detail}`,
      `HTTP_${response.status}`,
      'Check the request parameters and try again.',
    );
  }

  // The runtime's JSON parse error can embed a fragment of the
  // (vendor-controlled, potentially attacker-influenced) body; never let it
  // propagate into model-visible output. Fail closed instead.
  try {
    return (await response.json()) as T;
  } catch {
    throw new TalentLMSError(
      `TalentLMS returned a response that could not be parsed (HTTP ${response.status}).`,
      'INVALID_API_RESPONSE',
      'Try again. If the problem persists, the API response format may have changed — check for a connector update.',
    );
  }
}

/**
 * URL-encode form parameters, omitting undefined values.
 */
export function formEncode(params: Record<string, string | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined) as [string, string][];
  return new URLSearchParams(entries).toString();
}
