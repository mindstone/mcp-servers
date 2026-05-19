import { describe, expect, it } from 'vitest';
import { formatDriveRecoveryError } from '../src/tools/drive-handlers.js';

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
});
