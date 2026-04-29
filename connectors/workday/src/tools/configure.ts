/**
 * Workday credential configuration tool.
 *
 * Validates host (SSRF prevention), attempts token exchange + API probe,
 * persists via bridge, and updates runtime credentials.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WorkdayError, USER_AGENT, REQUEST_TIMEOUT_MS } from '../types.js';
import { withErrorHandling } from '../utils.js';
import {
  validateHost,
  setHost,
  setTenant,
  setClientId,
  setClientSecret,
  setRefreshToken,
  clearTokenCache,
} from '../auth.js';
import { bridgeRequest } from '../bridge.js';

export function registerConfigureTools(server: McpServer): void {
  server.registerTool(
    'configure_workday_credentials',
    {
      description: `Configure Workday API credentials. Call this when the user provides their Workday OAuth credentials.

SETUP PREREQUISITES:
1. A Workday Integration System User (ISU) with appropriate security group access
2. An API Client registered in Workday (Tenant Setup > API Clients)
3. The Client ID and Client Secret from the API Client registration
4. Optionally, a pre-generated Refresh Token (from OAuth token exchange)

PARAMETERS:
- host: Workday API domain (e.g., "wd5-impl-services1.workday.com")
- tenant: Your Workday tenant name (e.g., "acme_corp")
- client_id: OAuth Client ID from API Client registration
- client_secret: OAuth Client Secret
- refresh_token: (Optional) Pre-generated refresh token. If omitted, uses client_credentials grant.

COMMON MISTAKES:
- Host should be just the domain (e.g., "wd5-impl-services1.workday.com"), not a full URL
- Tenant name is case-sensitive
- The ISU must have permissions for the REST API resources you want to access`,
      inputSchema: z.object({
        host: z.string().describe('Workday API domain (e.g., "wd5-impl-services1.workday.com")'),
        tenant: z.string().describe('Workday tenant name (e.g., "acme_corp")'),
        client_id: z.string().describe('OAuth Client ID from Workday API Client registration'),
        client_secret: z.string().describe('OAuth Client Secret'),
        refresh_token: z.string().optional().describe('Optional refresh token. If omitted, client_credentials grant is used.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    withErrorHandling(async (args) => {
      const rawHost = args.host.trim();
      const tenant = args.tenant.trim();
      const cid = args.client_id.trim();
      const csecret = args.client_secret.trim();
      const rtoken = args.refresh_token?.trim() || undefined;

      if (!rawHost || !tenant || !cid || !csecret) {
        return JSON.stringify({ ok: false, error: 'host, tenant, client_id, and client_secret are all required.' });
      }

      // Normalize and validate host (SSRF prevention)
      const hostValidation = validateHost(rawHost);
      if (!hostValidation.valid) {
        return JSON.stringify({ ok: false, error: hostValidation.error });
      }
      const host = hostValidation.host!;

      // Validate credentials by attempting token exchange + API probe
      const authHeader = 'Basic ' + Buffer.from(`${cid}:${csecret}`).toString('base64');
      const bodyParams: Record<string, string> = rtoken
        ? { grant_type: 'refresh_token', refresh_token: rtoken }
        : { grant_type: 'client_credentials' };
      const body = new URLSearchParams(bodyParams);

      const tokenUrl = `https://${host}/ccx/oauth2/${tenant}/token`;
      let tokenResponse: Response;
      try {
        tokenResponse = await fetch(tokenUrl, {
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
            resolution: 'Verify the host domain is correct and accessible from your network.',
          });
        }
        return JSON.stringify({
          ok: false,
          error: `Could not reach Workday: ${error instanceof Error ? error.message : String(error)}`,
          resolution: 'Verify the host domain is correct and accessible from your network.',
        });
      }

      if (!tokenResponse.ok) {
        const errorBody = await tokenResponse.json().catch(() => ({})) as { error_description?: string; error?: string };
        const detail = errorBody?.error_description || errorBody?.error || `HTTP ${tokenResponse.status}`;
        return JSON.stringify({
          ok: false,
          error: `Token exchange failed: ${detail}`,
          resolution: tokenResponse.status === 401
            ? 'Check your Client ID and Client Secret. Ensure the API Client is registered correctly in Workday.'
            : tokenResponse.status === 400
              ? 'Check your tenant name and host domain. If using a refresh token, it may be expired or invalid.'
              : `Unexpected error (${tokenResponse.status}). Verify host, tenant, and credentials.`,
        });
      }

      const tokenData = await tokenResponse.json() as {
        access_token: string;
        token_type: string;
        expires_in: number;
        refresh_token?: string;
      };

      // API probe
      const testUrl = `https://${host}/ccx/api/v1/${tenant}/workers?limit=1`;
      let testResponse: Response;
      try {
        testResponse = await fetch(testUrl, {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
            Accept: 'application/json',
            'User-Agent': USER_AGENT,
          },
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'TimeoutError') {
          return JSON.stringify({
            ok: false,
            error: 'API probe timed out after successful token exchange.',
            resolution: 'Check network connectivity to Workday.',
          });
        }
        return JSON.stringify({
          ok: false,
          error: `API probe failed: ${error instanceof Error ? error.message : String(error)}`,
          resolution: 'Verify the host domain and network connectivity.',
        });
      }

      if (!testResponse.ok) {
        const status = testResponse.status;
        return JSON.stringify({
          ok: false,
          error: `Token exchange succeeded but API probe failed (${status}).`,
          resolution: status === 403
            ? 'The ISU lacks permissions for the Workers REST API. Add the Integration System Security Group to the "Worker Data" domain in Workday.'
            : status === 404
              ? 'Workers endpoint not found. Verify the tenant name and that REST API is enabled.'
              : `Unexpected API error (${status}). Check ISU permissions and REST API configuration.`,
        });
      }

      // Persist via bridge
      const result = await bridgeRequest('/bundled/workday/configure', {
        host, tenant, clientId: cid, clientSecret: csecret, refreshToken: rtoken,
      });

      if (!result.success) {
        throw new WorkdayError(
          result.error || 'Failed to configure Workday via bridge.',
          'BRIDGE_ERROR',
          'Check that the host application is running and bridge is available.',
        );
      }

      // Update runtime credentials
      setHost(host);
      setTenant(tenant);
      setClientId(cid);
      setClientSecret(csecret);
      setRefreshToken(rtoken ?? '');
      clearTokenCache();

      const message = result.warning
        ? `Workday configured successfully. Note: ${result.warning}`
        : 'Workday configured successfully! Try list_workday_workers to browse your team.';
      return JSON.stringify({ ok: true, message });
    }),
  );
}
