import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { authRequiredJson, errorJson, withErrorHandling } from '../utils.js';
import { getSlackClient, getSlackUserClient, getTokenProvider, getWorkspaces } from '../client.js';
import { ConnectorError, TOKEN_EXPIRED_REFRESH_DISABLED } from '../types.js';

export function registerAuthTools(server: McpServer): void {
  // ---------------------------------------------------------------------
  // authenticate_slack_workspace
  // ---------------------------------------------------------------------
  server.registerTool(
    'authenticate_slack_workspace',
    {
      description: `Connect a Slack workspace to enable all Slack operations.

ACTION REQUIRED: Call this tool when:
1. list_slack_workspaces shows no workspace connected
2. User asks to connect, set up, or configure Slack
3. Any Slack tool returns "not connected" error

This tool returns a structured auth_required response. The host will
recognise it and dispatch to the desktop OAuth flow. After the user
completes sign-in:
  1. Call list_slack_workspaces to verify the connection
  2. Slack tools become available immediately (no restart needed)`,
      inputSchema: z.object({}).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async () => authRequiredJson()),
  );

  // ---------------------------------------------------------------------
  // list_slack_workspaces
  // ---------------------------------------------------------------------
  server.registerTool(
    'list_slack_workspaces',
    {
      description: `Check Slack connection status. Call FIRST before any Slack operation.

Returns:
- connected: true/false
- workspaces: array of connected workspaces with team names
- tokenHealth: bot/user token status (valid|missing|refreshable|expired)

CRITICAL: If response shows connected=false, call authenticate_slack_workspace
to start the connection flow. The host will guide the user through OAuth.`,
      inputSchema: z.object({}).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async () => {
      // getWorkspaces now throws distinct ConnectorErrors for permission /
      // corruption — let them propagate; withErrorHandling surfaces them
      // with the right next_step from DEFAULT_NEXT_STEP_BY_CODE.
      const workspaces = getWorkspaces();
      if (workspaces.length === 0) {
        return JSON.stringify({
          ok: true,
          connected: false,
          workspaces: [],
          action_required:
            'Call authenticate_slack_workspace to start the connection flow. The host will surface the Slack sign-in prompt.',
          next_step: 'authenticate_slack_workspace',
        });
      }

      let tokenValid = false;
      let teamInfo: { team?: string; user?: string } | null = null;
      let botClient = null;
      try {
        botClient = await getSlackClient();
      } catch (err) {
        // Token expired AND refresh is disabled on this surface — surface
        // the structured auth_required so the host can dispatch reauth.
        // Other ConnectorErrors (e.g. NO_TOKEN) report as connected:false
        // with action_required guidance instead of fail-closing the call.
        if (err instanceof ConnectorError && err.code === TOKEN_EXPIRED_REFRESH_DISABLED) {
          return authRequiredJson();
        }
        // For all other resolution failures, leave botClient null and
        // continue — the response will report the workspace as not
        // connected with recovery guidance.
      }
      if (botClient) {
        try {
          const authResult = await botClient.auth.test();
          tokenValid = authResult.ok === true;
          teamInfo = { team: authResult.team, user: authResult.user };
        } catch {
          tokenValid = false;
        }
      }

      let userClient = null;
      try {
        userClient = await getSlackUserClient();
      } catch {
        // ignore — user token is non-fatal
      }

      const tokenProvider = getTokenProvider();
      const tokenData = tokenProvider ? await tokenProvider.loadTokens() : null;
      const ONE_HOUR_MS = 60 * 60 * 1000;
      const now = Date.now();

      let botTokenStatus: string;
      if (tokenValid) botTokenStatus = 'valid';
      else if (!tokenData?.botToken) botTokenStatus = 'missing';
      else if (tokenData?.botRefreshToken) botTokenStatus = 'refreshable';
      else botTokenStatus = 'expired';

      let userTokenStatus: string;
      if (userClient) userTokenStatus = 'valid';
      else if (!tokenData?.userToken) userTokenStatus = 'not_configured';
      else if (tokenData?.userRefreshToken) userTokenStatus = 'refreshable';
      else userTokenStatus = 'expired';

      const refreshEnabled = !!(tokenData?.botRefreshToken || tokenData?.userRefreshToken);
      const botNearExpiry =
        botTokenStatus === 'valid' && tokenData?.botExpiresAt
          ? tokenData.botExpiresAt < now + ONE_HOUR_MS
          : false;
      const userNearExpiry =
        userTokenStatus === 'valid' && tokenData?.userExpiresAt
          ? tokenData.userExpiresAt < now + ONE_HOUR_MS
          : false;

      return JSON.stringify({
        ok: true,
        connected: tokenValid,
        userTokenEnabled: !!userClient,
        tokenHealth: {
          botToken: botTokenStatus,
          userToken: userTokenStatus,
          refreshEnabled,
          ...(botNearExpiry ? { botTokenNearExpiry: true } : {}),
          ...(userNearExpiry ? { userTokenNearExpiry: true } : {}),
        },
        workspaces: workspaces.map((w) => ({
          teamId: w.teamId,
          teamName: w.teamName,
          connectedAt: w.authedAt,
        })),
        currentWorkspace: teamInfo,
        message: tokenValid
          ? `Connected to Slack workspace: ${workspaces[0].teamName}.`
          : 'Workspace configured but token may be invalid.',
        ...(tokenValid
          ? {}
          : {
              action_required:
                'Call authenticate_slack_workspace to refresh credentials.',
              next_step: 'authenticate_slack_workspace',
            }),
      });
    }),
  );
}

// expose the helper for tools that need to fail-closed with a not-connected error
export function notConnectedJson(): string {
  return errorJson({
    error: 'Slack not connected.',
    action_required: 'Call authenticate_slack_workspace to connect.',
    next_step: 'authenticate_slack_workspace',
  });
}
