import type { WebClient } from '@slack/web-api';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AUTH_REQUIRED_CODES, authRequiredJson, errorJson, isMissingScopeError, isTokenExpiredError, sanitizeErrorMessage, withErrorHandling } from '../utils.js';
import { getSlackClient, getSlackUserClient, getTokenProvider, getWorkspaces } from '../client.js';
import { ConnectorError } from '../types.js';
import { wrapUntrusted } from '../untrusted-content.js';

/**
 * Workspace names are chosen by workspace owners, so they are enveloped where
 * the model reads them (invariant #6). Team ids stay raw.
 */
const SLACK_WORKSPACE_NAME_SOURCE = 'slack:workspace-name';

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
- tokenHealth: bot/user token status (valid|refused|unavailable|missing|not_configured)

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

      async function probe(getClient: () => Promise<WebClient | null>, role: 'bot' | 'user') {
        const missingStatus = role === 'bot' ? 'missing' : 'not_configured';
        try {
          const client = await getClient();
          if (!client) return { valid: false, status: missingStatus, teamInfo: null };
          const result = await client.auth.test();
          return {
            valid: result.ok === true,
            status: result.ok === true ? 'valid' : 'unavailable',
            teamInfo: result.ok === true ? {
              team: wrapUntrusted(result.team, SLACK_WORKSPACE_NAME_SOURCE),
              user: result.user,
            } : null,
          };
        } catch (error) {
          const code = error instanceof ConnectorError ? error.code
            : (error as { data?: { error?: string } })?.data?.error;
          console.warn(
            { token_role: role, code: code ? sanitizeErrorMessage(code) : 'unavailable' },
            '[slack-mcp] Workspace authorization probe failed.',
          );
          const refused = isTokenExpiredError(error) || isMissingScopeError(error) ||
            (error instanceof ConnectorError && AUTH_REQUIRED_CODES.includes(error.code));
          return {
            valid: false,
            status: code === 'NO_TOKEN' ? missingStatus : refused ? 'refused' : 'unavailable',
            teamInfo: null,
            refreshDisabled: code === 'TOKEN_EXPIRED_REFRESH_DISABLED',
          };
        }
      }
      const bot = await probe(getSlackClient, 'bot');
      const user = await probe(getSlackUserClient, 'user');
      const connected = bot.valid || user.valid;
      if (!connected && (bot.refreshDisabled || user.refreshDisabled)) return authRequiredJson();
      const teamInfo = bot.teamInfo ?? user.teamInfo;

      const tokenProvider = getTokenProvider();
      const tokenData = tokenProvider ? await tokenProvider.loadTokens() : null;
      const ONE_HOUR_MS = 60 * 60 * 1000;
      const now = Date.now();

      const botTokenStatus = bot.status === 'missing' && tokenData?.botToken ? 'unavailable' : bot.status;
      const userTokenStatus = user.status === 'not_configured' && tokenData?.userToken ? 'unavailable' : user.status;

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
        connected,
        userTokenEnabled: user.valid,
        tokenHealth: {
          botToken: botTokenStatus,
          userToken: userTokenStatus,
          refreshEnabled,
          ...(botNearExpiry ? { botTokenNearExpiry: true } : {}),
          ...(userNearExpiry ? { userTokenNearExpiry: true } : {}),
        },
        workspaces: workspaces.map((w) => ({
          teamId: w.teamId,
          teamName: wrapUntrusted(w.teamName, SLACK_WORKSPACE_NAME_SOURCE),
          connectedAt: w.authedAt,
        })),
        currentWorkspace: teamInfo,
        message: connected
          ? `Connected to Slack workspace: ${wrapUntrusted(workspaces[0].teamName, SLACK_WORKSPACE_NAME_SOURCE)}.`
          : 'Workspace configured, but neither authorization passed the Slack connection check.',
        ...(connected
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
