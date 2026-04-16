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
function compactPerson(person) {
    const compact = {};
    for (const field of PERSON_LIST_FIELDS) {
        compact[field] = person[field];
    }
    const jobRole = person.jobRole;
    if (jobRole) {
        compact.jobTitle = jobRole.jobTitle;
        compact.department = jobRole.department;
    }
    return compact;
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
export function registerDicerollTools(server) {
    server.registerTool('diceroll_humaans_person', {
        description: `Pick a random person from the team using Humaans HR data.

Randomly selects one active employee and returns their profile summary.
Useful for stand-ups, retrospectives, pairings, or any time you need to pick someone at random.

Returns: name, email, job title, department, teams, and location of the selected person.

RELATED TOOLS:
- list_humaans_people: See who else is on the team`,
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true },
    }, withErrorHandling(async () => {
        if (!isConfigured())
            return noApiKeyError();
        const params = new URLSearchParams();
        params.set('$limit', '250');
        params.set('status', 'active');
        const result = await humaansFetch(`/people?${params.toString()}`);
        if (result.data.length === 0) {
            return JSON.stringify({
                ok: false,
                error: 'No active employees found in Humaans',
            });
        }
        // Pick one at random
        const index = Math.floor(Math.random() * result.data.length);
        const picked = compactPerson(result.data[index]);
        const total = result.data.length;
        return JSON.stringify({
            ok: true,
            picked,
            total,
            message: `🎲 The dice rolled and landed on ${picked.preferredName ?? picked.firstName} ${picked.lastName}! (picked from ${total} active employees)`,
        });
    }));
}
//# sourceMappingURL=diceroll.js.map