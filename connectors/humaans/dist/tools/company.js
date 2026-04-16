import { z } from 'zod';
import { humaansFetch } from '../client.js';
import { withErrorHandling } from '../utils.js';
import { isConfigured } from '../auth.js';
function paginationHint(total, skip, count) {
    if (count >= total)
        return `Showing all ${total} results.`;
    const remaining = total - skip - count;
    return `Showing ${count} of ${total} total (skip=${skip}). ${remaining > 0 ? `Use skip=${skip + count} to see more.` : ''}`;
}
function noApiKeyError() {
    return JSON.stringify({
        ok: false,
        error: 'Humaans API key not configured',
        resolution: 'Use configure_humaans_api_key to set your API key first.',
    });
}
export function registerCompanyTools(server) {
    server.registerTool('list_humaans_locations', {
        description: `List company locations/offices from Humaans.

Returns: label, city, country, timezone for each office location.
Note: Remote employees have locationId="remote" with remoteCity/remoteCountry fields on their person profile.

Example: {}`,
        inputSchema: z.object({
            limit: z.number().min(1).max(250).optional()
                .describe('Max results (default 100, max 250)'),
            skip: z.number().min(0).optional()
                .describe('Number of results to skip'),
        }),
        annotations: { readOnlyHint: true },
    }, withErrorHandling(async (args) => {
        if (!isConfigured())
            return noApiKeyError();
        const limit = Math.min(Math.max(args.limit ?? 100, 1), 250);
        const skip = Math.max(args.skip ?? 0, 0);
        const params = new URLSearchParams();
        params.set('$limit', String(limit));
        params.set('$skip', String(skip));
        const result = await humaansFetch(`/locations?${params.toString()}`);
        const hint = paginationHint(result.total, result.skip, result.data.length);
        return JSON.stringify({
            ok: true,
            locations: result.data,
            count: result.data.length,
            total: result.total,
            pagination: hint,
        });
    }));
    server.registerTool('get_humaans_company', {
        description: `Get company information from Humaans.

Returns: company name, status, trial info, timesheet settings.

Example: {}`,
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true },
    }, withErrorHandling(async () => {
        if (!isConfigured())
            return noApiKeyError();
        const result = await humaansFetch('/companies');
        if (result.data.length === 0) {
            return JSON.stringify({ ok: false, error: 'No company found.' });
        }
        return JSON.stringify({ ok: true, company: result.data[0] });
    }));
}
//# sourceMappingURL=company.js.map