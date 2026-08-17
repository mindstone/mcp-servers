import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { browserbaseFetch, requireApiKey } from '../client.js';
import { withErrorHandling } from '../utils.js';
import { sanitizeList, sanitizeProject } from '../sanitize.js';

export function registerProjectTools(server: McpServer): void {
  server.registerTool(
    'list_projects',
    {
      description: `List all Browserbase projects on the account.

WHEN TO USE:
- Find a project_id before creating sessions or contexts (the API key usually implies a default project, so this is often optional)
- Check each project's concurrency limit and default session timeout

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_browserbase_api_key

RELATED TOOLS:
- get_project_usage: Check browser minutes / proxy bytes consumed by a project
- create_session: Pass project_id to target a specific project

RETURNS: projects, count. Each project includes id, name, ownerId, defaultTimeout (seconds), concurrency, createdAt, updatedAt.`,
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async () => {
      requireApiKey();
      const result = await browserbaseFetch<unknown[]>('/projects', { method: 'GET' });
      const projects = sanitizeList(result, sanitizeProject, 'browserbase:list_projects');
      return JSON.stringify({
        ok: true,
        projects,
        count: projects.length,
        message: `Found ${projects.length} project(s).`,
      });
    }),
  );

  server.registerTool(
    'get_project',
    {
      description: `Get details of a single Browserbase project.

WHEN TO USE:
- Confirm a project's concurrency limit before opening many sessions
- Check the default session timeout applied to new sessions

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_browserbase_api_key
- 404: project_id not found → list_projects and retry with a returned ID

RELATED TOOLS:
- list_projects: Discover project IDs
- get_project_usage: Consumption numbers for the project

RETURNS: id, name, ownerId, defaultTimeout, concurrency, createdAt, updatedAt.`,
      inputSchema: {
        project_id: z.string().min(1).describe('The project ID (from list_projects).'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      requireApiKey();
      const result = await browserbaseFetch<Record<string, unknown>>(
        `/projects/${encodeURIComponent(args.project_id)}`,
        { method: 'GET' },
      );
      return JSON.stringify({
        ok: true,
        ...(sanitizeProject(result, 'browserbase:get_project') as Record<string, unknown>),
      });
    }),
  );

  server.registerTool(
    'get_project_usage',
    {
      description: `Get a project's current-period usage: browser minutes and proxy bytes consumed.

WHEN TO USE:
- Check spend drivers before launching a large batch of sessions
- Report usage back to the user

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_browserbase_api_key
- 404: project_id not found → list_projects and retry with a returned ID

RELATED TOOLS:
- list_projects: Discover project IDs
- list_sessions: See which sessions are currently consuming concurrency

RETURNS: project_id, browserMinutes, proxyBytes.`,
      inputSchema: {
        project_id: z.string().min(1).describe('The project ID (from list_projects).'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      requireApiKey();
      const result = await browserbaseFetch<Record<string, unknown>>(
        `/projects/${encodeURIComponent(args.project_id)}/usage`,
        { method: 'GET' },
      );
      return JSON.stringify({
        ok: true,
        project_id: args.project_id,
        browserMinutes: result.browserMinutes,
        proxyBytes: result.proxyBytes,
      });
    }),
  );
}
