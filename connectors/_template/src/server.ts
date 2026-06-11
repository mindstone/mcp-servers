import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorHandling } from './utils.js';
// SECURITY (AGENTS.md invariant #6): any text authored in the external system
// (names, descriptions, bodies, comments, titles, transcripts, …) is untrusted
// and MUST be enveloped before it reaches the LLM. `wrapUntrusted` is the shared
// helper; see ./untrusted-content.ts. New tools that return external text MUST
// either reach this helper or carry a `// untrusted-content-exempt: <reason>`
// marker (enforced by scripts/check-untrusted-coverage.mjs).
import { wrapUntrusted } from './untrusted-content.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

/**
 * Coerce a parseable date string (ISO 8601, RFC 2822, or a digit-only epoch-ms
 * string) to epoch milliseconds. Non-strings and un-coercible strings pass
 * through unchanged — the refine in epochMsField rejects the latter.
 */
const coerceEpochMs = (val: unknown): unknown => {
  if (typeof val !== 'string') return val;
  const trimmed = val.trim();
  if (trimmed === '') return val;
  if (/^\d+$/.test(trimmed)) {
    // Digit-only strings are accepted ONLY in the unambiguous epoch-ms window
    // [1e12, 1e14) (≈ Sep 2001 → year 5138). Anything else — Unix SECONDS
    // ("1735689600" would silently be 1000x off), microseconds, tiny values —
    // is returned unchanged so the refine rejects it with an actionable
    // message. Never let digit-only strings fall through to Date.parse:
    // V8 parses "5" as year 2005 and "0" as 2000.
    const num = Number(trimmed);
    return num >= 1e12 && num < 1e14 ? num : val;
  }
  const ms = new Date(trimmed).getTime();
  return Number.isNaN(ms) ? val : ms;
};

/**
 * STANDARD PATTERN for epoch-milliseconds fields — copy this for any tool
 * input that takes a Unix-ms timestamp. See CONTRIBUTING.md
 * "Date & timestamp fields".
 *
 * Why: strict MCP hosts validate a tool call against the connector's EXPORTED
 * JSON schema BEFORE the connector code runs, and LLMs frequently send ISO
 * date strings for epoch-ms fields. A bare z.number() schema gets such calls
 * rejected at the host boundary, where the connector never gets a chance to
 * coerce. This helper advertises BOTH number and string in the exported schema
 * (anyOf integer|string), coerces date strings to epoch ms at runtime, and
 * rejects un-coercible strings (including ambiguous digit-only strings such
 * as Unix seconds) via the refine.
 */
const epochMsField = () =>
  z.preprocess(coerceEpochMs, z.union([z.number().int(), z.string()]))
    .refine((v): v is number => typeof v === 'number', {
      message: 'Expected epoch milliseconds (number), a 13-digit epoch-ms string, or a parseable date string (e.g. "2026-01-01").',
    });

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'CONNECTOR_NAME-mcp-server',
    version: pkg.version,
  });

  // --- Example tool: configure credentials ---
  server.registerTool(
    'configure_CONNECTOR_NAME_api_key',
    {
      description: 'Configure the API key for CONNECTOR_NAME',
      inputSchema: z.object({
        api_key: z.string().min(1).describe('API key for authentication'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      // TODO: Implement credential storage (env, config file, or bridge)
      return JSON.stringify({
        ok: true,
        message: 'API key configured successfully',
      });
    }),
  );

  // --- Example tool: list resources ---
  server.registerTool(
    'list_CONNECTOR_NAME_resources',
    {
      description: 'List resources from CONNECTOR_NAME',
      inputSchema: z.object({
        limit: z.number().min(1).max(100).default(25).describe('Maximum number of results'),
        // Exemplar epoch-ms field: every date/timestamp description must state
        // the accepted forms with an example (see CONTRIBUTING.md).
        created_after: epochMsField().optional()
          .describe('Only resources created after this time. Unix timestamp in milliseconds (number, e.g. 1735689600000) or a parseable date string (e.g. "2026-01-01").'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      // TODO: Replace with real API call. The shape below shows the REQUIRED
      // pattern: every field whose value is authored in the external system
      // (here `name` and `description`) is wrapped with `wrapUntrusted(...)`
      // before being returned. Connector-controlled metadata (ids, counts,
      // timestamps, URLs) is NOT wrapped. The `source` argument identifies the
      // origin so the LLM (and audit logs) can see where the data came from.
      const resourcesFromApi: Array<{ id: string; name: string; description?: string }> = [];
      const resources = resourcesFromApi.map((r) => ({
        id: r.id,
        name: wrapUntrusted(r.name, 'CONNECTOR_NAME:resource.name'),
        description: wrapUntrusted(r.description, 'CONNECTOR_NAME:resource.description'),
      }));
      return JSON.stringify({
        ok: true,
        resources,
        total: resources.length,
      });
    }),
  );

  return server;
}
