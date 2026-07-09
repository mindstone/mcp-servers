export interface BridgeState {
  port: number;
  token: string;
}

export const REQUEST_TIMEOUT_MS = 30_000;

/** Per-call override for slow or binary conversational-AI endpoints. */
export const LONG_REQUEST_TIMEOUT_MS = 120_000;

export class ElevenLabsError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly resolution: string,
  ) {
    super(message);
    this.name = 'ElevenLabsError';
  }
}

export interface AudioResult {
  filePath: string;
  sizeBytes: number;
}

export interface PaginatedEnvelope<T> {
  items: T[];
  nextCursor?: string;
}

import { envelopeApiErrorDetail } from './error-detail.js';

export function getErrorResolution(status: number, detail?: string): string {
  const msg = (detail || '').toLowerCase();
  if (status === 401 || msg.includes('unauthorized') || msg.includes('invalid api key')) {
    return 'Authentication failed. Check your ElevenLabs API key in Settings. Get one at https://elevenlabs.io/app/settings/api-keys';
  }
  if (status === 403 || msg.includes('quota') || msg.includes('limit') || msg.includes('credits')) {
    return 'Insufficient permission or quota for this Conversational AI endpoint. Check your ElevenLabs account and key scopes at https://elevenlabs.io/app/settings/api-keys';
  }
  if (status === 404) {
    return 'The requested resource was not found. Re-list the resource and retry with the exact returned ID.';
  }
  if (status === 422 || msg.includes('validation')) {
    const base = 'Invalid request parameters. Check the input values and try again.';
    if (detail) {
      return `${base} Field issues: ${envelopeApiErrorDetail(detail)}`;
    }
    return base;
  }
  if (status === 429) {
    return 'Rate limited. Wait a moment and try again.';
  }
  return 'Please try again. If the issue persists, verify your API key, account permissions, and upstream ElevenLabs service status.';
}
