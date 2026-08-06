import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getApiKey, setApiKey, getDomain, setDomain, normalizeTalentLmsSubdomainInput, isValidSubdomain } from '../auth.js';
import { bridgeRequest, BRIDGE_STATE_PATH } from '../bridge.js';
import { TalentLMSError } from '../types.js';
import { withErrorHandling } from '../utils.js';

export function registerConfigureTools(server: McpServer): void {
  server.registerTool(
    'configure_talentlms',
    {
      description:
        'Host-managed setup only. The user adds the TalentLMS API key and domain in Settings → Connectors in the app. Do not ask for or accept the key in chat.\n\n' +
        'WORKFLOW:\n' +
        '1. Go to your TalentLMS admin panel → Account & Settings → Security\n' +
        '2. Enable API access\n' +
        '3. Copy the API key\n' +
        '4. Your domain is the subdomain part of your URL (e.g., "acme" for acme.talentlms.com)\n\n' +
        'Note: Requires a paid TalentLMS plan and Super Admin access.',
      inputSchema: z.object({
        api_key: z.string().min(1).describe('TalentLMS API key'),
        domain: z.string().min(1).describe('TalentLMS subdomain (e.g., "acme" for acme.talentlms.com)'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    withErrorHandling(async (args) => {
      const apiKey = args.api_key.trim();
      const domain = normalizeTalentLmsSubdomainInput(args.domain);

      if (!apiKey || !domain) {
        return JSON.stringify({ ok: false, error: 'Both api_key and domain are required.' });
      }

      if (!isValidSubdomain(domain)) {
        return JSON.stringify({
          ok: false,
          error: 'Invalid domain. Enter just the subdomain part (e.g., "acme" or "acme.eu"), or paste your TalentLMS URL (e.g., https://acme.talentlms.com).',
        });
      }

      // If bridge is available, persist via bridge
      if (BRIDGE_STATE_PATH) {
        try {
          const result = await bridgeRequest('/bundled/talentlms/configure', { apiKey, domain });
          if (result.success) {
            setApiKey(apiKey);
            setDomain(domain);
            const message = result.warning
              ? `TalentLMS configured successfully. Note: ${result.warning}`
              : `TalentLMS configured successfully for ${domain}.talentlms.com! Try list_talentlms_users or list_talentlms_courses.`;
            return JSON.stringify({ ok: true, message });
          }
          // Bridge returned failure — surface as error, do NOT fall through
          throw new TalentLMSError(
            result.error || 'Bridge configuration failed',
            'BRIDGE_ERROR',
            'The host app bridge rejected the configuration request. Check the host app logs.',
          );
        } catch (error) {
          if (error instanceof TalentLMSError) throw error;
          // Bridge request failed (network, timeout, etc.) — surface a fixed
          // message; raw exception text can embed environment details.
          console.error('[talentlms] Bridge request failed:', error);
          throw new TalentLMSError(
            'Bridge request failed',
            'BRIDGE_ERROR',
            'Could not reach the host app bridge. Ensure the host app is running.',
          );
        }
      }

      // No bridge — store in-memory
      setApiKey(apiKey);
      setDomain(domain);
      return JSON.stringify({
        ok: true,
        message: `TalentLMS configured successfully for ${domain}.talentlms.com! Try list_talentlms_users or list_talentlms_courses.`,
      });
    }),
  );
}
