import { describe, expect, it } from 'vitest';
import { formatDriveRecoveryError } from '../src/tools/drive-handlers.js';
import { createGoogleRetryConfig } from '../src/utils/google-retry.js';

describe('Drive recovery-guidance errors', () => {
  it('returns recovery guidance for Drive 403 failures', () => {
    const response = formatDriveRecoveryError('list files', {
      response: { status: 403 },
      message: 'Forbidden',
    });

    expect(response).toEqual({
      ok: false,
      action_required: 'Drive list files failed (403)',
      next_step: 'Forbidden. Check Google Workspace authentication and Drive permissions, then retry.',
    });
  });

  it('returns rate-limit guidance when Drive retries are exhausted', () => {
    const error = Object.assign(new Error('Quota exceeded for quota metric per minute'), {
      response: { status: 403 },
      config: { method: 'GET', retryConfig: { currentRetryAttempt: 7 } },
    });
    createGoogleRetryConfig().shouldRetry(error as never);

    expect(formatDriveRecoveryError('list files', error)).toEqual({
      ok: false,
      recoveryExhausted: true,
      action_required: 'Drive list files failed (403)',
      next_step: 'Google Workspace rate limit reached. Back off before retrying, reduce the request size if possible, then try again.',
    });
  });

  it.each([403, 429])('returns rate-limit guidance for a Drive write rate limit without exhaustion (%s)', status => {
    const error = Object.assign(new Error(status === 403 ? 'Quota exceeded for quota metric per minute' : 'Too many requests'), {
      response: { status },
    });

    expect(formatDriveRecoveryError('delete file', error)).toEqual({
      ok: false,
      action_required: `Drive delete file failed (${status})`,
      next_step: 'Google Workspace rate limit reached. Back off before retrying, reduce the request size if possible, then try again.',
    });
  });
});
