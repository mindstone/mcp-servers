import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { browserbaseFetch, browserbaseFetchText, requireApiKey } from '../client.js';
import { withErrorHandling } from '../utils.js';
import {
  browserSettingsSchema,
  proxiesSchema,
  regionSchema,
} from './common.js';
import { buildUploadFormData } from './file-upload.js';
import {
  sanitizeDebugUrls,
  sanitizeList,
  sanitizeReplayPage,
  sanitizeSession,
  sanitizeSessionLog,
} from '../sanitize.js';
import { wrapUntrusted } from '../untrusted-content.js';

const sessionStatusSchema = z.enum(['PENDING', 'RUNNING', 'ERROR', 'TIMED_OUT', 'COMPLETED']);

const WORKSPACE_HINT =
  'Local file path to upload. The path must resolve inside MCP_WORKSPACE_PATH (or the system temp directory when unset) — paths outside the workspace sandbox are rejected before any disk read.';

export function registerSessionTools(server: McpServer): void {
  server.registerTool(
    'create_session',
    {
      description: `Create a new cloud browser session and get a connect URL for driving it (e.g. via Playwright over CDP).

WHEN TO USE:
- You need a real browser to automate: scraping, form filling, screenshots, authenticated flows
- Before create_agent_run when you want a persistent context attached

BILLING & LIMITS:
- Sessions are billed per browser-minute with a 1-minute minimum per session — end sessions you no longer need with end_session
- Sessions auto-expire at the project defaultTimeout (or the timeout you pass) — you do not have to end them, but idle sessions still bill until they expire or are released
- Exceeding the project concurrency limit returns 429 — check list_sessions and end unused sessions, or raise limits in the Browserbase dashboard

GOTCHAS:
- The returned connectUrl is a credentialed WebSocket URL — treat it like a secret and do not share it publicly
- keep_alive keeps the session alive when the driver disconnects; without it, disconnecting ends the session
- To resume a logged-in state, create a context first (create_context) and pass browser_settings.context

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_browserbase_api_key
- 429: concurrency/rate limit → wait for the retry-after window, end unused sessions
- 400: invalid parameters → check browser_settings field shapes

RELATED TOOLS:
- get_session_debug_urls: Get a live-view URL a human can watch
- end_session: Release the session when done
- upload_session_file: Push a local file into the session's filesystem

RETURNS: the session object (id, status, projectId, region, expiresAt, …) plus connectUrl.`,
      inputSchema: {
        project_id: z.string().optional()
          .describe('Project ID to create the session in. Omit to use the project implied by the API key.'),
        extension_id: z.string().optional()
          .describe('Uploaded Extension ID to load in the browser (from upload_extension).'),
        browser_settings: browserSettingsSchema.optional()
          .describe('Browser configuration: context, viewport, stealth, recording, domain allow-list, and more.'),
        timeout: z.number().int().min(60).max(21600).optional()
          .describe('Session timeout in seconds (60-21600). Defaults to the project defaultTimeout. The session ends automatically when this elapses.'),
        keep_alive: z.boolean().optional()
          .describe('Keep the session alive when the driver disconnects, so you can reconnect later. Default: false (disconnect ends the session).'),
        proxies: proxiesSchema.optional()
          .describe('Proxy configuration: true for Browserbase managed proxies, or an array of proxy configs. Default: no proxies.'),
        proxy_settings: z.object({
          ca_certificates: z.array(z.string()).optional()
            .describe('IDs of uploaded CA certificates (from upload_certificate) to trust for TLS-inspecting proxies.'),
        }).optional().describe('Advanced proxy settings.'),
        region: regionSchema.optional()
          .describe('Region to run the browser in. Pick the region closest to the target site for lower latency. Default: us-west-2.'),
        user_metadata: z.record(z.unknown()).optional()
          .describe('Arbitrary JSON metadata to attach to the session (e.g. {"ticket": "ACME-123"}). Queryable later via list_sessions q filter.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      requireApiKey();
      const body: Record<string, unknown> = {};
      if (args.project_id) body.projectId = args.project_id;
      if (args.extension_id) body.extensionId = args.extension_id;
      if (args.browser_settings) {
        const bs = args.browser_settings;
        body.browserSettings = {
          ...(bs.context ? { context: bs.context } : {}),
          ...(bs.extensionId ? { extensionId: bs.extensionId } : {}),
          ...(bs.viewport ? { viewport: bs.viewport } : {}),
          ...(bs.blockAds !== undefined ? { blockAds: bs.blockAds } : {}),
          ...(bs.solveCaptchas !== undefined ? { solveCaptchas: bs.solveCaptchas } : {}),
          ...(bs.recordSession !== undefined ? { recordSession: bs.recordSession } : {}),
          ...(bs.logSession !== undefined ? { logSession: bs.logSession } : {}),
          ...(bs.advancedStealth !== undefined ? { advancedStealth: bs.advancedStealth } : {}),
          ...(bs.verified !== undefined ? { verified: bs.verified } : {}),
          ...(bs.captchaImageSelector ? { captchaImageSelector: bs.captchaImageSelector } : {}),
          ...(bs.captchaInputSelector ? { captchaInputSelector: bs.captchaInputSelector } : {}),
          ...(bs.os ? { os: bs.os } : {}),
          ...(bs.allowedDomains ? { allowedDomains: bs.allowedDomains } : {}),
          ...(bs.ignoreCertificateErrors !== undefined ? { ignoreCertificateErrors: bs.ignoreCertificateErrors } : {}),
        };
      }
      if (args.timeout !== undefined) body.timeout = args.timeout;
      if (args.keep_alive !== undefined) body.keepAlive = args.keep_alive;
      if (args.proxies !== undefined) body.proxies = args.proxies;
      if (args.proxy_settings) {
        body.proxySettings = {
          ...(args.proxy_settings.ca_certificates ? { caCertificates: args.proxy_settings.ca_certificates } : {}),
        };
      }
      if (args.region) body.region = args.region;
      if (args.user_metadata) body.userMetadata = args.user_metadata;

      const result = await browserbaseFetch<Record<string, unknown>>(
        '/sessions',
        { method: 'POST', body },
      );
      return JSON.stringify({
        ok: true,
        ...(sanitizeSession(result, 'browserbase:create_session') as Record<string, unknown>),
        message: `Session created (id: ${result.id}). Connect a driver via connectUrl, share the live view via get_session_debug_urls, and release it with end_session when done.`,
      });
    }),
  );

  server.registerTool(
    'list_sessions',
    {
      description: `List browser sessions, newest first, optionally filtered by status or metadata.

WHEN TO USE:
- Find running sessions (status=RUNNING) to debug, reuse, or end
- Check concurrency pressure before creating more sessions
- Locate a session you tagged with user_metadata via the q filter

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_browserbase_api_key

RELATED TOOLS:
- get_session: Full details and connectUrl for one session
- end_session: Release sessions you no longer need

RETURNS: sessions, count. Each session includes id, status, projectId, region, startedAt, expiresAt, keepAlive, contextId, userMetadata.`,
      inputSchema: {
        status: sessionStatusSchema.optional()
          .describe('Only sessions in this state. Use RUNNING to find active sessions.'),
        q: z.string().optional()
          .describe('Query string matched against session userMetadata (e.g. a value you set in create_session user_metadata).'),
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
      const result = await browserbaseFetch<unknown[]>('/sessions', {
        method: 'GET',
        query: { status: args.status, q: args.q },
      });
      const sessions = sanitizeList(result, sanitizeSession, 'browserbase:list_sessions');
      return JSON.stringify({
        ok: true,
        sessions,
        count: sessions.length,
        message: `Found ${sessions.length} session(s).`,
      });
    }),
  );

  server.registerTool(
    'get_session',
    {
      description: `Get full details of a browser session, including its connectUrl while it is still running.

WHEN TO USE:
- Check whether a session is RUNNING, COMPLETED, TIMED_OUT, or in ERROR
- Retrieve the connectUrl to attach a driver to a keep-alive session

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_browserbase_api_key
- 404: session_id not found → the session may have expired; find active ones with list_sessions

RELATED TOOLS:
- get_session_debug_urls: Live-view URLs for a running session
- end_session: Release it

RETURNS: the session object plus connectUrl (present while the session is connectable).`,
      inputSchema: {
        session_id: z.string().min(1).describe('The session ID (from create_session or list_sessions).'),
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
        `/sessions/${encodeURIComponent(args.session_id)}`,
        { method: 'GET' },
      );
      return JSON.stringify({
        ok: true,
        ...(sanitizeSession(result, 'browserbase:get_session') as Record<string, unknown>),
      });
    }),
  );

  server.registerTool(
    'end_session',
    {
      description: `Release (end) a browser session — sends a REQUEST_RELEASE so the browser shuts down and billing stops.

WHEN TO USE:
- As soon as automation against a session is finished; every running session bills per browser-minute (1-minute minimum)

NOTE: This is a "release", not a hard delete: the session transitions to COMPLETED and its logs/recordings remain retrievable. Sessions also end automatically when they time out, so a missed end_session is not fatal — just slower and more expensive. Ending an already-ended session is safe (the request is idempotent in effect).

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_browserbase_api_key
- 404: session_id not found → it may already be gone; check list_sessions

RELATED TOOLS:
- list_sessions: Find RUNNING sessions to release
- get_session: Confirm the status flipped to COMPLETED

RETURNS: ok, message.`,
      inputSchema: {
        session_id: z.string().min(1).describe('The session ID to release.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      requireApiKey();
      await browserbaseFetch<Record<string, unknown>>(
        `/sessions/${encodeURIComponent(args.session_id)}`,
        { method: 'POST', body: { status: 'REQUEST_RELEASE' } },
      );
      return JSON.stringify({
        ok: true,
        message: `Session ${args.session_id} released (status set to REQUEST_RELEASE). It will transition to COMPLETED.`,
      });
    }),
  );

  server.registerTool(
    'get_session_debug_urls',
    {
      description: `Get live-view and Chrome DevTools debugger URLs for a session, plus per-page debugger URLs.

WHEN TO USE:
- Give a human a link to WATCH the browser live — share debuggerFullscreenUrl with the user
- Attach a CDP driver yourself via wsUrl
- See which pages/tabs the session currently has open

GOTCHAS:
- Only meaningful while the session is RUNNING; for finished sessions use get_session_replays or the recording downloads
- The debugger URLs grant live control of the browser — share them only with people who should operate the session

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_browserbase_api_key
- 404: session_id not found → list_sessions for active sessions

RELATED TOOLS:
- get_session: Status + connectUrl
- get_session_replays: Post-hoc replay after the session ends

RETURNS: debuggerFullscreenUrl (shareable live view), debuggerUrl, wsUrl, and pages[] (id, url, title, debuggerUrl, …).`,
      inputSchema: {
        session_id: z.string().min(1).describe('The session ID (must be running for useful URLs).'),
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
        `/sessions/${encodeURIComponent(args.session_id)}/debug`,
        { method: 'GET' },
      );
      return JSON.stringify({
        ok: true,
        ...(sanitizeDebugUrls(result, 'browserbase:get_session_debug_urls') as Record<string, unknown>),
      });
    }),
  );

  server.registerTool(
    'get_session_logs',
    {
      description: `Get the CDP-level event log for a session (every DevTools-protocol request/response, e.g. network calls).

WHEN TO USE:
- Debug what an automation actually did: which requests fired, what the page returned
- Requires logSession enabled (default) at session creation

GOTCHAS:
- Log entries can be very large; request/response rawBody values are truncated beyond ~4KB with a truncation note
- This is raw protocol data — prefer get_session_replays for a watchable summary

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_browserbase_api_key
- 404: session_id not found → list_sessions

RELATED TOOLS:
- get_session_replays: Human-watchable replay instead of raw logs
- get_session: Check the session exists

RETURNS: logs, count. Each entry has method, pageId, sessionId, timestamp, request{params, rawBody}, response{result, rawBody}.`,
      inputSchema: {
        session_id: z.string().min(1).describe('The session ID to fetch logs for.'),
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
      const result = await browserbaseFetch<unknown[]>(
        `/sessions/${encodeURIComponent(args.session_id)}/logs`,
        { method: 'GET' },
      );
      const logs = sanitizeList(result, sanitizeSessionLog, 'browserbase:get_session_logs');
      return JSON.stringify({
        ok: true,
        logs,
        count: logs.length,
        message: `Found ${logs.length} log entr${logs.length === 1 ? 'y' : 'ies'}. rawBody values longer than ~4KB are truncated with a note.`,
      });
    }),
  );

  server.registerTool(
    'get_session_replays',
    {
      description: `List the recorded pages of a session available for replay (requires recordSession, the default, at creation).

WHEN TO USE:
- After a session ends, to see what happened page by page
- To get a page_id for get_session_replay_playlist

NOTE: The legacy rrweb recording endpoint (GET /sessions/{id}/recording) is deprecated upstream and is intentionally not exposed — use replays (watchable) and recording downloads (MP4) instead.

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_browserbase_api_key
- 404: session_id not found → list_sessions

RELATED TOOLS:
- get_session_replay_playlist: Fetch the m3u8 playlist for one page
- request_session_recording_downloads: Get a downloadable MP4 instead

RETURNS: pages[] (pageId, url, startTimeMs, endTimeMs), pageCount.`,
      inputSchema: {
        session_id: z.string().min(1).describe('The session ID to list replay pages for.'),
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
        `/sessions/${encodeURIComponent(args.session_id)}/replays`,
        { method: 'GET' },
      );
      const pages = sanitizeList(result.pages, sanitizeReplayPage, 'browserbase:get_session_replays');
      return JSON.stringify({
        ok: true,
        pages,
        pageCount: typeof result.pageCount === 'number' ? result.pageCount : pages.length,
      });
    }),
  );

  server.registerTool(
    'get_session_replay_playlist',
    {
      description: `Fetch the HLS (m3u8) replay playlist for one recorded page of a session — the raw playlist text a video player consumes.

WHEN TO USE:
- You have a page_id from get_session_replays and need the actual replay stream manifest

GOTCHAS:
- Returns playlist text, not a playable URL — point an HLS-capable player at it or share the dashboard replay instead
- Replay data expires with the session's retention window; expired data returns 410

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_browserbase_api_key
- 404: session/page not found → get_session_replays for valid page_ids
- 410: replay data expired → it cannot be recovered

RELATED TOOLS:
- get_session_replays: Discover page_ids
- get_session_recording_downloads: MP4 download as an alternative

RETURNS: playlist (m3u8 text, wrapped as untrusted content), session_id, page_id.`,
      inputSchema: {
        session_id: z.string().min(1).describe('The session ID.'),
        page_id: z.string().min(1).describe('The page ID from get_session_replays (e.g. "0").'),
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
      const playlist = await browserbaseFetchText(
        `/sessions/${encodeURIComponent(args.session_id)}/replays/${encodeURIComponent(args.page_id)}`,
        { method: 'GET' },
      );
      return JSON.stringify({
        ok: true,
        session_id: args.session_id,
        page_id: args.page_id,
        // Playlist text is upstream-authored — envelope it (invariant #6).
        playlist: wrapUntrusted(playlist, 'browserbase:get_session_replay_playlist:playlist'),
      });
    }),
  );

  server.registerTool(
    'request_session_recording_downloads',
    {
      description: `Request MP4 assembly of a session's recording (async — returns 202 immediately, files are built in the background).

WHEN TO USE:
- You want a downloadable MP4 of what happened in a session (requires recordSession, the default)

WORKFLOW:
1. request_session_recording_downloads → kicks off assembly (HTTP 202)
2. Poll get_session_recording_downloads until each page's status is COMPLETED
3. Open the short-lived signed downloadUrl (re-minted on every GET — always take the freshest)

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_browserbase_api_key
- 404: session not found → list_sessions
- 409: recording unavailable in the session's current state → confirm the session recorded (recordSession) and has ended
- 422: recording download cannot be completed for this session → check session state

RELATED TOOLS:
- get_session_recording_downloads: Poll assembly status and get signed URLs
- get_session_replays: Browser-based replay without downloading

RETURNS: ok, message. Assembly status is tracked per page via get_session_recording_downloads.`,
      inputSchema: {
        session_id: z.string().min(1).describe('The session ID whose recording should be assembled as MP4.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      requireApiKey();
      await browserbaseFetch<Record<string, unknown>>(
        `/sessions/${encodeURIComponent(args.session_id)}/recording/downloads`,
        { method: 'POST' },
      );
      return JSON.stringify({
        ok: true,
        message: `Recording download requested for session ${args.session_id} (HTTP 202 — assembly is async). Poll get_session_recording_downloads until status is COMPLETED.`,
      });
    }),
  );

  server.registerTool(
    'get_session_recording_downloads',
    {
      description: `Check MP4 recording assembly status for each recorded page of a session, with signed download URLs when ready.

WHEN TO USE:
- Poll after request_session_recording_downloads until status is COMPLETED

GOTCHAS:
- downloadUrl is short-lived and re-minted on every call — download promptly and always use the URL from the latest response
- FAILED status means assembly failed; call request_session_recording_downloads again to retry
- Recording data expires with retention; expired data returns 410

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_browserbase_api_key
- 404: session not found → list_sessions
- 410: recording data expired → cannot be recovered; re-run the session

RELATED TOOLS:
- request_session_recording_downloads: Start assembly
- get_session_replays: Watch in a browser instead

RETURNS: downloads[] (pageId, status NOT_REQUESTED|PENDING|COMPLETED|FAILED, downloadUrl?, completedAt?).`,
      inputSchema: {
        session_id: z.string().min(1).describe('The session ID to check recording downloads for.'),
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
        `/sessions/${encodeURIComponent(args.session_id)}/recording/downloads`,
        { method: 'GET' },
      );
      const downloads = Array.isArray(result.downloads) ? result.downloads : [];
      // downloadUrl is a short-lived signed CDN URL minted by Browserbase —
      // not third-party prose — so it is intentionally not enveloped.
      return JSON.stringify({
        ok: true,
        downloads,
        count: downloads.length,
        message: 'downloadUrl values are short-lived signed URLs, re-minted on every call. Poll until status is COMPLETED.',
      });
    }),
  );

  server.registerTool(
    'upload_session_file',
    {
      description: `Upload a local file into a running session's filesystem — it lands at /tmp/.uploads/<filename> inside the browser machine.

WHEN TO USE:
- An automation needs a local file (CSV, image, PDF) inside the browser, e.g. for a file-input upload on a page

SECURITY: file_path is sandboxed — the path must resolve inside MCP_WORKSPACE_PATH (or the system temp directory when unset); anything outside is rejected before any disk read.

ERROR RECOVERY:
- 401: API key is missing or invalid → configure_browserbase_api_key
- 404: session not found → the session may have ended; check list_sessions
- FILE_OUTSIDE_WORKSPACE: move/copy the file into the workspace directory first

RELATED TOOLS:
- create_session: The session must exist (RUNNING) before uploading
- get_session: Confirm the session is still alive

RETURNS: ok, message with the in-session path (/tmp/.uploads/<filename>).`,
      inputSchema: {
        session_id: z.string().min(1).describe('The session ID to upload into (must be running).'),
        file_path: z.string().min(1).describe(WORKSPACE_HINT),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      requireApiKey();
      const form = await buildUploadFormData(args.file_path);
      await browserbaseFetch<Record<string, unknown>>(
        `/sessions/${encodeURIComponent(args.session_id)}/uploads`,
        { method: 'POST', body: form },
      );
      const filename = (form.get('file') as File | null)?.name ?? 'file';
      return JSON.stringify({
        ok: true,
        message: `File uploaded to session ${args.session_id}. It is available inside the session at /tmp/.uploads/${filename}.`,
      });
    }),
  );
}
