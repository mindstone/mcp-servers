import { createRequire } from 'node:module';
import { z } from 'zod';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export const REQUEST_TIMEOUT_MS = 30_000;
/** Upper bound on vendor-authored error text included in error messages. */
export const MAX_VENDOR_ERROR_CHARS = 500;
export const OUTREACH_API_BASE = 'https://api.outreach.io/api/v2';
export const OUTREACH_OAUTH_URL = 'https://api.outreach.io/oauth/token';
export const OUTREACH_AUTHORIZE_URL = 'https://api.outreach.io/oauth/authorize';
export const SERVER_NAME = 'outreach-mcp-server';
/** Server version reported on MCP `initialize`. Read from package.json so
 *  it cannot drift from the published npm version. */
export const SERVER_VERSION = pkg.version;

export class ConnectorError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly resolution: string,
  ) {
    super(message);
    this.name = 'ConnectorError';
  }
}

export type AuthMode = 'bridge' | 'standalone_oauth' | 'manual_token' | 'unconfigured';

// Stored credential files are parsed with these schemas, never cast. Older
// files may lack `refresh_token` (an exchange reply without one was written
// with the key dropped), so it defaults to '' and refresh then asks the user
// to reconnect, exactly as before.
export const outreachTokenDataSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().default(''),
  expires_at: z.number(),
  scope: z.string().default(''),
  created_at: z.number().default(0),
  username: z.string().optional(),
});

export type OutreachTokenData = z.infer<typeof outreachTokenDataSchema>;

export const outreachAccountSchema = z.object({
  id: z.string().min(1),
  username: z.string(),
  connected_at: z.string(),
});

export type OutreachAccount = z.infer<typeof outreachAccountSchema>;

export const outreachAccountsConfigSchema = z.object({
  accounts: z.array(outreachAccountSchema),
});

export type OutreachAccountsConfig = z.infer<typeof outreachAccountsConfigSchema>;

export interface JsonApiResource {
  id: string;
  type: string;
  attributes: Record<string, unknown>;
  relationships?: Record<string, {
    data: { id: string; type: string } | { id: string; type: string }[] | null;
  }>;
  links?: Record<string, string>;
}

export interface JsonApiResponse {
  data: JsonApiResource | JsonApiResource[];
  meta?: { count?: number; page?: { current?: number; total?: number } };
  links?: { next?: string; prev?: string };
}
