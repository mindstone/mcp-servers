import { z } from 'zod';
import { humaansFetch } from '../client.js';
import { withErrorHandling } from '../utils.js';
import { isConfigured } from '../auth.js';
// Fields to include in compact person list responses (allowlist for security)
const PERSON_LIST_FIELDS = [
    'id', 'firstName', 'lastName', 'preferredName', 'email',
    'status', 'contractType', 'teams', 'locationId',
    'employmentStartDate', 'employmentEndDate', 'timezone',
];
// Fields to strip from full person responses (sensitive data)
const PERSON_SENSITIVE_FIELDS = [
    'calendarFeedToken', 'taxId', 'taxCode',
    'personalEmail', 'personalPhoneNumber', 'formattedPersonalPhoneNumber',
    'birthday', 'address', 'city', 'state', 'postcode', 'countryCode',
    'profilePhoto', 'profilePhotoId',
    'nationality', 'nationalities', 'gender',
    'dietaryPreference', 'foodAllergies',
];
function compactPerson(person) {
    const compact = {};
    for (const field of PERSON_LIST_FIELDS) {
        compact[field] = person[field];
    }
    // Include inline job role info if present
    const jobRole = person.jobRole;
    if (jobRole) {
        compact.jobTitle = jobRole.jobTitle;
        compact.department = jobRole.department;
    }
    return compact;
}
function sanitizePerson(person) {
    const sanitized = { ...person };
    for (const field of PERSON_SENSITIVE_FIELDS) {
        delete sanitized[field];
    }
    return sanitized;
}
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
        resolution: 'To use Humaans, you need to configure an API access token first.',
        next_step: {
            action: 'Ask the user for their Humaans API token, then call configure_humaans_api_key',
            tool_to_call: 'configure_humaans_api_key',
            tool_parameters: { api_key: '<user_provided_token>' },
            get_key_from: 'https://app.humaans.io/settings/home?tokens=1',
        },
    });
}
export function registerPeopleTools(server) {
    server.registerTool('get_humaans_me', {
        description: `Get the current authenticated user's profile from Humaans.

Returns: name, email, job title, department, teams, location, status.
Use this to get your own personId for other operations (e.g., creating time away).

RELATED TOOLS:
- create_humaans_time_away: Use the returned id as personId
- list_humaans_time_away: Filter by your personId`,
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true },
    }, withErrorHandling(async () => {
        if (!isConfigured())
            return noApiKeyError();
        const me = await humaansFetch('/me');
        return JSON.stringify({ ok: true, person: sanitizePerson(me) });
    }));
    server.registerTool('list_humaans_people', {
        description: `List employees from Humaans HR.

By default returns only active employees. Use status filter for other groups.
Returns compact summaries: id, name, email, job title, department, teams, location, status.

Example: { "status": "active", "team": "Engineering", "limit": 50 }

Pagination: Returns up to 'limit' results (default 50, max 250). Use 'skip' for next page.

RELATED TOOLS:
- get_humaans_person: Pass an employee's id to get their full profile
- list_humaans_job_roles: Pass personId to see job role history`,
        inputSchema: z.object({
            status: z.enum(['active', 'offboarded', 'newHire', 'all']).optional()
                .describe('Filter by employment status. Default: active'),
            email: z.string().optional()
                .describe('Filter by exact work email address'),
            team: z.string().optional()
                .describe('Filter by team name (e.g., "Engineering", "Sales")'),
            limit: z.number().min(1).max(250).optional()
                .describe('Max results per page (default 50, max 250)'),
            skip: z.number().min(0).optional()
                .describe('Number of results to skip (for pagination)'),
        }),
        annotations: { readOnlyHint: true },
    }, withErrorHandling(async (args) => {
        if (!isConfigured())
            return noApiKeyError();
        const limit = Math.min(Math.max(args.limit ?? 50, 1), 250);
        const skip = Math.max(args.skip ?? 0, 0);
        const params = new URLSearchParams();
        params.set('$limit', String(limit));
        params.set('$skip', String(skip));
        if (args.status)
            params.set('status', args.status);
        if (args.email)
            params.set('email', args.email);
        if (args.team)
            params.set('teams', args.team);
        const result = await humaansFetch(`/people?${params.toString()}`);
        const people = result.data.map(compactPerson);
        const hint = paginationHint(result.total, result.skip, people.length);
        return JSON.stringify({
            ok: true,
            people,
            count: people.length,
            total: result.total,
            pagination: hint,
        });
    }));
    server.registerTool('get_humaans_person', {
        description: `Get full employee profile from Humaans by their ID.

Returns detailed profile including: name, email, job role, department, teams,
location, employment dates, contract type, working days, manager, bio, social links.
Sensitive fields (tax ID, personal email, home address) are redacted for privacy.

Example: { "personId": "VMB1yzL5uL8VvNNCJc9rykJz" }

WORKFLOW - To find a person:
1. Call list_humaans_people to search (filter by email or team)
2. Use the person's id from the results here`,
        inputSchema: z.object({
            personId: z.string().min(1).describe('The person ID (from list_humaans_people)'),
        }),
        annotations: { readOnlyHint: true },
    }, withErrorHandling(async (args) => {
        if (!isConfigured())
            return noApiKeyError();
        const person = await humaansFetch(`/people/${encodeURIComponent(args.personId)}`);
        return JSON.stringify({ ok: true, person: sanitizePerson(person) });
    }));
}
//# sourceMappingURL=people.js.map