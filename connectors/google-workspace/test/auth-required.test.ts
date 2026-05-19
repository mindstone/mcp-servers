import { describe, expect, it } from 'vitest';
import { handleAuthenticateWorkspaceAccount } from '../src/tools/account-handlers.js';

describe('authenticate_workspace_account', () => {
  it('returns the host-orchestrated auth_required shape without URL fields', async () => {
    const result = await handleAuthenticateWorkspaceAccount({});
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;

    expect(payload).toEqual({
      status: 'auth_required',
      user_action: { id: 'google.connect_account' },
      agent_action: {
        instruction: "Connect Google Workspace to continue. The user will be redirected to Google's sign-in.",
      },
      setupToolName: 'authenticate_workspace_account',
    });
    expect(JSON.stringify(payload)).not.toContain('auth_url');
    expect(JSON.stringify(payload)).not.toContain('authUrl');
    expect(JSON.stringify(payload)).not.toContain('type');
  });
});
