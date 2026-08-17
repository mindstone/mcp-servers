import { z } from 'zod';

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
 * Epoch-milliseconds field that advertises BOTH number and string in the
 * exported JSON schema (anyOf integer|string), while coercing date strings to
 * epoch ms and rejecting un-coercible strings (including ambiguous digit-only
 * strings such as Unix seconds) at runtime.
 *
 * Why: strict MCP hosts validate a tool call against the exported schema
 * BEFORE the connector runs, and LLMs frequently send ISO date strings for
 * epoch-ms fields. A bare z.number() schema gets such calls rejected at the
 * host boundary, where the connector never gets a chance to coerce.
 * See CONTRIBUTING.md "Date & timestamp fields".
 *
 * The Browserbase API wants ISO date-time strings on its date filters, so
 * handlers convert the resulting epoch ms with `epochMsToIso` before sending.
 */
export const epochMsField = () =>
  z.preprocess(coerceEpochMs, z.union([z.number().int(), z.string()]))
    .refine((v): v is number => typeof v === 'number', {
      message: 'Expected epoch milliseconds (number), a 13-digit epoch-ms string, or a parseable date string (e.g. "2026-01-01").',
    });

/** Standard description suffix for epoch-ms fields (CONTRIBUTING.md). */
export const EPOCH_MS_FIELD_HINT =
  'Unix timestamp in milliseconds (number, e.g. 1735689600000) or a parseable date string (e.g. "2026-01-01").';

/** Convert epoch ms to the ISO 8601 date-time string the API expects. */
export function epochMsToIso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/** Shared `{ id, persist? }` reference to a browser context. */
export const contextRefSchema = z.object({
  id: z.string().min(1).describe('The Context ID (from create_context).'),
  persist: z.boolean().optional()
    .describe('Whether to persist the context (cookies, storage) after the session ends. Default: false.'),
});

/** Proxy configuration union accepted by session creation and agent runs. */
export const proxiesSchema = z.union([
  z.literal(true).describe('Enable Browserbase managed proxies with default settings.'),
  z.array(z.discriminatedUnion('type', [
    z.object({
      type: z.literal('browserbase').describe('Browserbase managed residential proxy network.'),
      geolocation: z.object({
        country: z.string().length(2).describe('Country code in ISO 3166-1 alpha-2 format (e.g. "US").'),
        state: z.string().length(2).optional().describe('US state code, 2 characters (e.g. "CA"). Requires country "US".'),
        city: z.string().optional().describe('City name; use spaces for multi-word names (e.g. "San Francisco").'),
      }).optional().describe('Optional geographic location for the proxy exit node.'),
      domainPattern: z.string().optional()
        .describe('Domain pattern this proxy applies to (e.g. "*.example.com"). Omit to proxy all domains.'),
    }),
    z.object({
      type: z.literal('external').describe('Your own proxy server.'),
      server: z.string().min(1).describe('Proxy server URL (e.g. "http://proxy.example.com:8080").'),
      username: z.string().optional().describe('Username for proxy authentication.'),
      password: z.string().optional().describe('Password for proxy authentication.'),
      domainPattern: z.string().optional()
        .describe('Domain pattern this proxy applies to. Omit to proxy all domains.'),
    }),
    z.object({
      type: z.literal('none').describe('Disable proxies for the matching domain pattern.'),
      domainPattern: z.string().optional()
        .describe('Domain pattern to exclude from proxying. Omit to disable proxies entirely.'),
    }),
  ])).describe('Ordered list of proxy configurations; the first matching domainPattern wins.'),
]);

/** Full browserSettings object accepted by POST /sessions. */
export const browserSettingsSchema = z.object({
  context: contextRefSchema.optional()
    .describe('Attach a persistent browser context (cookies, storage) to the session.'),
  extensionId: z.string().optional()
    .describe('Uploaded Extension ID to load in the browser (from upload_extension).'),
  viewport: z.object({
    width: z.number().int().positive().describe('Browser viewport width in pixels (e.g. 1920).'),
    height: z.number().int().positive().describe('Browser viewport height in pixels (e.g. 1080).'),
  }).optional().describe('Browser viewport size. Browserbase picks a default when omitted.'),
  blockAds: z.boolean().optional().describe('Enable ad blocking in the browser. Default: false.'),
  solveCaptchas: z.boolean().optional().describe('Enable automatic captcha solving. Default: true.'),
  recordSession: z.boolean().optional()
    .describe('Record the session (enables get_session_replays and recording downloads). Default: true.'),
  logSession: z.boolean().optional()
    .describe('Enable CDP-level session logging (enables get_session_logs). Default: true.'),
  advancedStealth: z.boolean().optional()
    .describe('Enable advanced stealth mode (requires a plan that includes it).'),
  verified: z.boolean().optional().describe('Enable Browserbase Verified browser mode.'),
  captchaImageSelector: z.string().optional()
    .describe('Custom CSS selector for the captcha image element (custom captcha solving).'),
  captchaInputSelector: z.string().optional()
    .describe('Custom CSS selector for the captcha input element (custom captcha solving).'),
  os: z.enum(['windows', 'mac', 'linux', 'mobile', 'tablet']).optional()
    .describe('Operating system fingerprint for stealth mode.'),
  allowedDomains: z.array(z.string()).optional()
    .describe('Restrict the session to these domains (e.g. ["example.com"]). All other navigation is blocked.'),
  ignoreCertificateErrors: z.boolean().optional()
    .describe('Ignore TLS certificate errors in the session. Use only for sites you control.'),
});

/** Reduced browserSettings accepted by POST /agents/runs. */
export const agentRunBrowserSettingsSchema = z.object({
  context: contextRefSchema.optional()
    .describe('Attach a persistent browser context (cookies, storage) to the run\'s session.'),
  proxies: proxiesSchema.optional().describe('Proxy configuration for the run\'s session.'),
  verified: z.boolean().optional().describe('Enable Browserbase Verified browser mode for the session.'),
});

export const regionSchema = z.enum(['us-west-2', 'us-east-1', 'eu-central-1', 'ap-southeast-1']);
