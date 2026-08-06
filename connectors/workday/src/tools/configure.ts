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
  assertHostResolvesPublic,
  parseTokenResponse,
  setHost,
  setTenant,
  setClientId,
  setClientSecret,
  setRefreshToken,
  clearTokenCache,
} from '../auth.js';
import { bridgeRequest } from '../bridge.js';
import { wrapUntrusted } from '../untrusted-content.js';

export function registerConfigureTools(server: McpServer): void {
  server.registerTool(
    'configure_workday_credentials',
    {
      description: `Host-managed setup only. The user adds their Workday OAuth credentials in Settings → Connectors in the app. Do not ask for or accept credentials in chat.

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

      // Re-resolve the host and refuse non-public DNS records before the
      // credential-bearing token exchange leaves the process.
      try {
        await assertHostResolvesPublic(host);
      } catch (error) {
        if (error instanceof WorkdayError) {
          return JSON.stringify({ ok: false, error: error.message, resolution: error.resolution });
        }
        throw error;
      }

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
          // Never auto-follow redirects: the Basic-auth credential would be
          // replayed to a vendor/proxy-controlled redirect target.
          redirect: 'manual',
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
          error: 'Could not reach the Workday token endpoint.',
          resolution: 'Verify the host domain is correct and accessible from your network.',
        });
      }

      if (!tokenResponse.ok) {
        // The OAuth error body is vendor/proxy-controlled and may reflect the
        // credentials just sent — never propagate it. Bounded, connector-
        // authored messages keyed on the status code only.
        if (tokenResponse.status >= 300 && tokenResponse.status < 400) {
          return JSON.stringify({
            ok: false,
            error: `Token endpoint attempted a redirect (HTTP ${tokenResponse.status}), which was refused.`,
            resolution: 'Verify the host domain is correct.',
          });
        }
        return JSON.stringify({
          ok: false,
          error: `Token exchange failed (HTTP ${tokenResponse.status}).`,
          resolution: tokenResponse.status === 401
            ? 'Check your Client ID and Client Secret. Ensure the API Client is registered correctly in Workday.'
            : tokenResponse.status === 400
              ? 'Check your tenant name and host domain. If using a refresh token, it may be expired or invalid.'
              : `Unexpected error (${tokenResponse.status}). Verify host, tenant, and credentials.`,
        });
      }

      // The token body is vendor/proxy-controlled — validate shape and bounds
      // (bounded expires_in) before using it for the API probe.
      let tokenData;
      try {
        tokenData = parseTokenResponse(await tokenResponse.json());
      } catch (error) {
        if (error instanceof WorkdayError) {
          return JSON.stringify({ ok: false, error: error.message, resolution: error.resolution });
        }
        throw error;
      }

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
          redirect: 'manual',
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
          error: 'API probe failed: could not reach the Workday API.',
          resolution: 'Verify the host domain and network connectivity.',
        });
      }

      if (!testResponse.ok) {
        const status = testResponse.status;
        if (status >= 300 && status < 400) {
          return JSON.stringify({
            ok: false,
            error: `API probe attempted a redirect (HTTP ${status}), which was refused.`,
            resolution: 'Verify the host domain is correct.',
          });
        }
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
        // Bridge-authored error text crosses a process boundary — envelope it
        // like any other non-connector-authored string before it reaches the
        // model.
        throw new WorkdayError(
          wrapUntrusted(result.error, 'workday-bridge') ?? 'Failed to configure Workday via bridge.',
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
        ? `Workday configured successfully. Note: ${wrapUntrusted(result.warning, 'workday-bridge')}`
        : 'Workday configured successfully! Try list_workday_workers to browse your team.';
      return JSON.stringify({ ok: true, message });
    }),
  );
}
