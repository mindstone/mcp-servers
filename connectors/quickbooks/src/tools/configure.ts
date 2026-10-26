/**
 * QuickBooks credential configuration tool.
 *
 * Validates credentials with the connector's one token grant (auth.ts
 * requestToken), persists the refresh token that grant left in force via the
 * bridge, and updates runtime credentials.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorHandling } from '../utils.js';
import { wrapUntrusted } from '../untrusted-content.js';
import {
  setClientId,
  setClientSecret,
  setRefreshToken,
  setRealmId,
  setEnvironment,
  validateEnvironment,
  requestToken,
  adoptTokenResponse,
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

      // Validate credentials with a grant. Intuit may rotate the refresh token
      // on it, so from here on the token in force is the one the grant
      // returned, not the one typed in.
      const grant = await requestToken({ clientId: cid, clientSecret: csecret, refreshToken: rtoken });
      if (!grant.ok) {
        const { failure } = grant;
        switch (failure.kind) {
          case 'timeout':
            return JSON.stringify({
              ok: false,
              error: 'Token exchange request timed out.',
              resolution: 'Verify your network connectivity.',
            });
          case 'network':
            return JSON.stringify({
              ok: false,
              error: `Could not reach Intuit OAuth: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`,
              resolution: 'Verify your network connectivity.',
            });
          case 'http':
            return JSON.stringify({
              ok: false,
              error: `Invalid credentials: ${failure.code ? `${failure.code} (HTTP ${failure.status})` : `HTTP ${failure.status}`}`,
              resolution: 'Check your Client ID, Client Secret, and Refresh Token. Refresh tokens expire after 100 days of inactivity.',
            });
          case 'malformed':
            return JSON.stringify({
              ok: false,
              error: `Intuit OAuth returned a non-JSON or malformed response (HTTP ${failure.status}).`,
              resolution: 'Try again; if it persists, check the Intuit service status.',
            });
          default: {
            const unreachable: never = failure;
            throw unreachable;
          }
        }
      }
      const refreshTokenInForce = grant.token.refresh_token ?? rtoken;

      // Persist via bridge
      const result = await bridgeRequest('/bundled/quickbooks/configure', {
        clientId: cid, clientSecret: csecret, refreshToken: refreshTokenInForce, realmId: rid, environment: env,
      });

      if (!result.success) {
        // Bridge-authored text crosses a process boundary — envelope it
        // (AGENTS.md #6), as the Workday connector does.
        return JSON.stringify({
          ok: false,
          error: wrapUntrusted(result.error, 'quickbooks-bridge') ?? 'Failed to configure QuickBooks via bridge.',
        });
      }

      // Update runtime credentials, and keep the grant's access token so the
      // first tool call does not spend another grant.
      setClientId(cid);
      setClientSecret(csecret);
      setRefreshToken(refreshTokenInForce);
      setRealmId(rid);
      setEnvironment(env);
      adoptTokenResponse(grant.token);

      const message = result.warning
        ? `QuickBooks Online configured successfully. Note: ${wrapUntrusted(result.warning, 'quickbooks-bridge')}`
        : 'QuickBooks Online configured successfully! Try list_quickbooks_invoices or list_quickbooks_customers.';
      return JSON.stringify({ ok: true, message });
    }),
  );
}
