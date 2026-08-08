/**
 * QuickBooks credential configuration tool.
 *
 * Validates credentials via token exchange, persists via bridge,
 * and updates runtime credentials.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { QuickBooksError, TOKEN_URL, USER_AGENT, REQUEST_TIMEOUT_MS } from '../types.js';
import { withErrorHandling } from '../utils.js';
import { wrapUntrusted } from '../untrusted-content.js';
import {
  setClientId,
  setClientSecret,
  setRefreshToken,
  setRealmId,
  setEnvironment,
  clearTokenCache,
  validateEnvironment,
} from '../auth.js';
import { bridgeRequest } from '../bridge.js';

export function registerConfigureTools(server: McpServer): void {
  server.registerTool(
    'configure_quickbooks',
    {
      description: `Configure QuickBooks Online credentials. Call this when the user provides their Intuit Developer app credentials.

WORKFLOW:
1. Go to https://developer.intuit.com/ and create an app (or use existing)
2. Get the Client ID and Client Secret from the app's Keys & credentials page
3. Add http://localhost:8000/callback as a Redirect URI
4. Use the OAuth Playground or your app's auth flow to obtain a Refresh Token
5. Find your Company ID (Realm ID) in the URL when logged into QuickBooks Online

COMMON MISTAKES:
- Refresh tokens expire after 100 days of inactivity — re-authenticate if you get auth errors
- The Realm ID is NOT the same as the Client ID — it's your company identifier
- Sandbox and Production use different credentials`,
      inputSchema: z.object({
        clientId: z.string().describe('Intuit Developer app Client ID'),
        clientSecret: z.string().describe('Intuit Developer app Client Secret'),
        refreshToken: z.string().describe('OAuth2 refresh token from the authorization flow'),
        realmId: z.string().describe('QuickBooks company ID (Realm ID)'),
        environment: z.enum(['sandbox', 'production']).optional().default('production')
          .describe('"sandbox" or "production" (default: production)'),
      }),
      // configure_quickbooks stores credentials via the host bridge; it does NOT
      // perform any destructive write against the user's QuickBooks company data,
      // so configure_quickbooks is annotated as non-destructive.
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    withErrorHandling(async (args) => {
      const cid = args.clientId.trim();
      const csecret = args.clientSecret.trim();
      const rtoken = args.refreshToken.trim();
      const rid = args.realmId.trim();
      const env = args.environment?.trim().toLowerCase() ?? 'production';

      if (!cid || !csecret || !rtoken || !rid) {
        return JSON.stringify({ ok: false, error: 'clientId, clientSecret, refreshToken, and realmId are all required.' });
      }

      if (!validateEnvironment(env)) {
        return JSON.stringify({ ok: false, error: 'environment must be "sandbox" or "production".' });
      }

      // Validate credentials by attempting a token refresh
      const authHeader = 'Basic ' + Buffer.from(`${cid}:${csecret}`).toString('base64');
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: rtoken,
      });

      let tokenResponse: Response;
      try {
        tokenResponse = await fetch(TOKEN_URL, {
          method: 'POST',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: {
            Authorization: authHeader,
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
            'User-Agent': USER_AGENT,
          },
          body: body.toString(),
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'TimeoutError') {
          return JSON.stringify({
            ok: false,
            error: 'Token exchange request timed out.',
            resolution: 'Verify your network connectivity.',
          });
        }
        return JSON.stringify({
          ok: false,
          error: `Could not reach Intuit OAuth: ${error instanceof Error ? error.message : String(error)}`,
          resolution: 'Verify your network connectivity.',
        });
      }

      if (!tokenResponse.ok) {
        const errorBody = await tokenResponse.json().catch(() => ({})) as { error_description?: string };
        // Intuit-controlled text heading to the model — envelope it (AGENTS.md #6).
        const detail = errorBody?.error_description
          ? wrapUntrusted(errorBody.error_description, 'quickbooks:oauth-error')
          : `HTTP ${tokenResponse.status}`;
        return JSON.stringify({
          ok: false,
          error: `Invalid credentials: ${detail}`,
          resolution: 'Check your Client ID, Client Secret, and Refresh Token. Refresh tokens expire after 100 days of inactivity.',
        });
      }

      // Persist via bridge
      const result = await bridgeRequest('/bundled/quickbooks/configure', {
        clientId: cid, clientSecret: csecret, refreshToken: rtoken, realmId: rid, environment: env,
      });

      if (!result.success) {
        return JSON.stringify({ ok: false, error: result.error || 'Failed to configure QuickBooks via bridge.' });
      }

      // Update runtime credentials
      setClientId(cid);
      setClientSecret(csecret);
      setRefreshToken(rtoken);
      setRealmId(rid);
      setEnvironment(env);
      clearTokenCache();

      const message = result.warning
        ? `QuickBooks Online configured successfully. Note: ${result.warning}`
        : 'QuickBooks Online configured successfully! Try list_quickbooks_invoices or list_quickbooks_customers.';
      return JSON.stringify({ ok: true, message });
    }),
  );
}
