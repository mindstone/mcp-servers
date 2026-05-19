/**
 * Office sidecar — App Bridge `/intent/*` proxy.
 *
 * Forwards a narrow allowlist of `/intent/*` requests from the Office
 * task-pane (loaded from `https://127.0.0.1:<sidecar-port>`) to the App
 * Bridge (`http://127.0.0.1:<bridge-port>`) server-to-server. Designed to
 * eliminate a whole class of browser-side CORS/Origin failures that hit
 * Word/Excel/PowerPoint task-panes:
 *
 *  - The bridge's Origin allowlist accepts only `chrome-extension://…`
 *    and `moz-extension://…` origins. A fetch from the Office task-pane
 *    origin would be 401'd by `assertAllowedOrigin`, AND the CORS layer
 *    would refuse to echo `Access-Control-Allow-Origin`, so the browser
 *    would hide the response body from JS → `NETWORK_ERROR` → Word shows
 *    "Rebel isn't responding right now."
 *
 *  - By routing through the sidecar instead, every `/intent/*` call is a
 *    Node → Node loopback request with no browser CORS. Node's fetch /
 *    http.request omits the `Origin` header by default, so the bridge's
 *    `allowMissingOrigin: true` path (shipped alongside this) passes the
 *    request through to the paired-app-token gate, which is and always
 *    was the real security boundary.
 *
 * Security posture:
 *  - Caller must present a valid sidecar Bearer token (same one used for
 *    the existing command-routing + `/sidecar/identify` endpoints). The
 *    outer `sidecar/index.ts` runs this check BEFORE dispatching here.
 *  - Path allowlist: only the shipped `/intent/conversation/*` +
 *    `/intent/health` routes proxy through. Arbitrary `/intent/…` paths
 *    get a 404, and any other HTTP method gets a 405.
 *  - Bridge auth (app token + client id) is attached server-side so the
 *    task-pane never sees the paired token — it can only exercise the
 *    routes we've curated here.
 *
 * @see docs/plans/260423_office_addin_intent_proxy.md
 */

import http from 'node:http';
import { URL } from 'node:url';

/** Bridge auth details returned by `ensureBridgeAuth` in `sidecar/index.ts`. */
export interface BridgeAuthSnapshot {
  /** e.g. `http://127.0.0.1:52320` */
  bridgeOrigin: string;
  /** Paired app token minted via `/host/mint-app-token`. */
  bridgeAppToken: string;
  /** Stable client id the token was minted against. */
  bridgeClientId: string;
}

export type IntentProxyAuthInvalidationReason = 'unauthorized' | 'revoked';

export interface IntentProxyDeps {
  /**
   * Returns a valid bridge-auth snapshot or null when the bridge state
   * file is unreachable / the mint round-trip failed. Must be cheap to
   * call repeatedly — the production implementation in
   * `sidecar/index.ts` is backed by a `(port, startedAt)`-keyed cache.
   */
  ensureBridgeAuth: () => Promise<BridgeAuthSnapshot | null>;
  /**
   * Optional diagnostic recorder owned by the sidecar process. Used to mirror
   * `[sidecar-proxy]` lines into the in-memory `/diag/tail` ring buffer.
   */
  recordDiagLine?: (line: string) => void;
  /**
   * Optional bridge-auth cache invalidation callback. Used to clear the
   * sidecar's cached minted bridge token when upstream auth is rejected or
   * when an SSE stream emits `revoked`.
   */
  invalidateCachedMintedToken?: (
    reason: IntentProxyAuthInvalidationReason,
  ) => void;
  /**
   * Inactivity timeout for proxied stream responses (ms). When the upstream
   * stream stalls without ending, the proxy tears down the downstream socket.
   */
  streamReadTimeoutMs?: number;
}

/**
 * Strict allowlist of proxied paths. We deliberately spell them out so a
 * future addition to the bridge's `/intent/*` surface doesn't accidentally
 * become reachable from the Office task-pane without explicit review.
 */
const ALLOWED_PATHS: readonly RegExp[] = [
  /^\/intent\/health$/,
  /^\/intent\/conversation\/create$/,
  /^\/intent\/conversation\/stream$/,
  /^\/intent\/conversation\/[A-Za-z0-9_-]+\/message$/,
  /^\/intent\/conversation\/[A-Za-z0-9_-]+\/focus$/,
  /^\/intent\/conversation\/[A-Za-z0-9_-]+\/messages$/,
  /^\/intent\/conversation\/[A-Za-z0-9_-]+\/stream$/,
];

/** `true` when the request path is one we're willing to proxy. */
export function isIntentProxyPath(pathname: string): boolean {
  return ALLOWED_PATHS.some((re) => re.test(pathname));
}

/** Streaming SSE endpoint — needs keepalive + content-type passthrough. */
function isStreamPath(pathname: string): boolean {
  return (
    pathname === '/intent/conversation/stream' ||
    /^\/intent\/conversation\/[A-Za-z0-9_-]+\/stream$/.test(pathname)
  );
}

/** Body-carrying methods. GET/HEAD don't need request-body pipe. */
function hasRequestBody(method: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH';
}

const DEFAULT_STREAM_READ_TIMEOUT_MS = 30_000;
const REQUEST_ID_HEADER_NAME = 'x-rebel-diag-id';

function emitProxyLine(deps: IntentProxyDeps, line: string): void {
  deps.recordDiagLine?.(line);
  console.error(line);
}

function readRequestCorrelationId(
  header: string | string[] | undefined,
): string | null {
  if (typeof header === 'string') {
    const trimmed = header.trim();
    return trimmed.length > 0 ? trimmed.slice(0, 80) : null;
  }
  if (Array.isArray(header)) {
    return readRequestCorrelationId(header[0]);
  }
  return null;
}

/**
 * Handle a `/intent/*` request by forwarding it to the App Bridge with
 * the sidecar's paired app token attached. Always terminates the
 * response (either with a bridge-sourced response or a proxy-sourced
 * error body).
 *
 * Caller contract: the sidecar's request handler must have already
 * authenticated the caller via the sidecar bearer token. `pathname` is
 * the url pathname without query string (the query is preserved from
 * `req.url` when forwarding).
 */
export async function handleIntentProxy(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: IntentProxyDeps,
  pathname: string,
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();

  if (!isIntentProxyPath(pathname)) {
    sendProxyError(res, 404, 'NOT_FOUND', 'Path not proxied.');
    return;
  }

  // The bridge only implements GET/POST on /intent/*. Reject anything
  // else early so Node doesn't accidentally buffer an unbounded body.
  if (method !== 'GET' && method !== 'POST') {
    sendProxyError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed on intent proxy.');
    return;
  }

  const auth = await deps.ensureBridgeAuth();
  if (!auth) {
    sendProxyError(
      res,
      503,
      'BRIDGE_NOT_READY',
      'Rebel App Bridge is not reachable or not paired yet.',
    );
    return;
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(
      `${pathname}${extractQueryString(req.url)}`,
      auth.bridgeOrigin,
    );
  } catch {
    sendProxyError(res, 400, 'BAD_REQUEST', 'Could not construct upstream URL.');
    return;
  }

  const forwardedHeaders: http.OutgoingHttpHeaders = {
    Authorization: `Bearer ${auth.bridgeAppToken}`,
    'X-Rebel-App-Id': 'office-addin',
    'X-Rebel-Client-Id': auth.bridgeClientId,
  };
  const requestId = readRequestCorrelationId(req.headers[REQUEST_ID_HEADER_NAME]);
  if (requestId) {
    forwardedHeaders['X-Rebel-Diag-Id'] = requestId;
  }

  // Pass through accept so SSE requests get the right framing from the
  // bridge. content-type is set AFTER any body rewrite below.
  const incomingAccept = req.headers['accept'];
  if (typeof incomingAccept === 'string' && incomingAccept.length > 0) {
    forwardedHeaders['Accept'] = incomingAccept;
  }

  // For JSON POSTs the bridge's Zod schemas require `appId` + `clientId`
  // in the body. The task-pane deliberately doesn't send them — we stamp
  // them here so the sole owner of `office-addin` identity is the
  // sidecar. Non-JSON POSTs and GETs stream through untouched.
  let rewrittenBody: Buffer | null = null;
  if (method === 'POST' && isJsonContentType(req.headers['content-type'])) {
    try {
      rewrittenBody = await readAndStampJsonBody(req, auth.bridgeClientId);
    } catch (err) {
      sendProxyError(
        res,
        400,
        'BAD_REQUEST',
        `Invalid JSON body: ${err instanceof Error ? err.message : 'parse error'}.`,
      );
      return;
    }
    forwardedHeaders['Content-Type'] = 'application/json; charset=utf-8';
    forwardedHeaders['Content-Length'] = rewrittenBody.length.toString();
  } else {
    // Passthrough path: preserve client-supplied content-type +
    // content-length so the bridge (or its intermediaries) can frame
    // the body correctly.
    const incomingContentType = req.headers['content-type'];
    if (typeof incomingContentType === 'string' && incomingContentType.length > 0) {
      forwardedHeaders['Content-Type'] = incomingContentType;
    }
    const incomingContentLength = req.headers['content-length'];
    if (
      hasRequestBody(method) &&
      typeof incomingContentLength === 'string' &&
      incomingContentLength.length > 0
    ) {
      forwardedHeaders['Content-Length'] = incomingContentLength;
    }
  }

  // Diagnostic logging — 260424 bug where Word taskpane can't reach bridge.
  const proxyId = Math.random().toString(36).slice(2, 8);
  const proxyStart = Date.now();
  emitProxyLine(
    deps,
    `[sidecar-proxy] outbound id=${proxyId} requestId=${requestId ?? '-'} ${method} ${targetUrl.origin}${pathname} clientId=${auth.bridgeClientId} appTokenLen=${auth.bridgeAppToken.length}`,
  );

  let settled = false;
  const settle = (): void => {
    settled = true;
  };

  const outbound = http.request(
    {
      method,
      hostname: targetUrl.hostname,
      port: targetUrl.port,
      path: `${targetUrl.pathname}${targetUrl.search}`,
      headers: forwardedHeaders,
    },
    (upstream) => {
      const status = upstream.statusCode ?? 502;
      const dur = Date.now() - proxyStart;
      let revokedDetected = false;
      let revokedScanTail = '';
      if (status === 401) {
        deps.invalidateCachedMintedToken?.('unauthorized');
        emitProxyLine(
          deps,
          `[sidecar-proxy] auth-cache-invalidated id=${proxyId} requestId=${requestId ?? '-'} reason=unauthorized path=${pathname}`,
        );
      }
      emitProxyLine(
        deps,
        `[sidecar-proxy] upstream-head id=${proxyId} requestId=${requestId ?? '-'} status=${status} dur=${dur}ms ct=${
          String(upstream.headers['content-type'] ?? '-').slice(0, 60)
        }`,
      );
      const responseHeaders: Record<string, string> = {};
      const upstreamContentType = upstream.headers['content-type'];
      if (typeof upstreamContentType === 'string' && upstreamContentType.length > 0) {
        responseHeaders['Content-Type'] = upstreamContentType;
      }
      if (isStreamPath(pathname)) {
        // SSE-specific hints so intermediaries don't buffer or cache.
        responseHeaders['Cache-Control'] = 'no-cache, no-transform';
        responseHeaders['Connection'] = 'keep-alive';
        responseHeaders['X-Accel-Buffering'] = 'no';
      }

      res.writeHead(status, responseHeaders);
      if (isStreamPath(pathname)) {
        const timeoutMs =
          deps.streamReadTimeoutMs === undefined
            ? DEFAULT_STREAM_READ_TIMEOUT_MS
            : deps.streamReadTimeoutMs;
        upstream.setTimeout(timeoutMs, () => {
          if (settled) return;
          settle();
          emitProxyLine(
            deps,
            `[sidecar-proxy] upstream-timeout id=${proxyId} requestId=${requestId ?? '-'} idleMs=${timeoutMs} path=${pathname}`,
          );
          try {
            outbound.destroy(new Error('Upstream stream read timeout'));
          } catch {
            // already destroyed
          }
          if (!res.writableEnded) {
            try {
              res.destroy(new Error('Proxy stream read timeout'));
            } catch {
              res.end();
            }
          }
        });
      }
      const clearStreamReadTimeout = (): void => {
        if (!isStreamPath(pathname)) {
          return;
        }
        try {
          if (upstream.socket) {
            upstream.setTimeout(0);
          }
        } catch {
          // Socket already gone.
        }
      };
      upstream.on('data', (chunk: Buffer) => {
        if (isStreamPath(pathname) && !settled) {
          const scan = `${revokedScanTail}${chunk.toString('utf8')}`;
          if (
            !revokedDetected &&
            (scan.includes('event: revoked') || scan.includes('"type":"revoked"'))
          ) {
            revokedDetected = true;
            deps.invalidateCachedMintedToken?.('revoked');
            emitProxyLine(
              deps,
              `[sidecar-proxy] auth-cache-invalidated id=${proxyId} requestId=${requestId ?? '-'} reason=revoked path=${pathname}`,
            );
          }
          revokedScanTail = scan.slice(-96);
        }
        if (!res.writableEnded) res.write(chunk);
      });
      upstream.on('end', () => {
        clearStreamReadTimeout();
        if (!res.writableEnded) res.end();
        settle();
      });
      upstream.on('error', (err) => {
        clearStreamReadTimeout();
        emitProxyLine(
          deps,
          `[sidecar-proxy] upstream-err id=${proxyId} requestId=${requestId ?? '-'} msg=${String(err.message).slice(0, 200)}`,
        );
        if (!res.writableEnded) res.end();
        settle();
      });
      upstream.on('close', () => {
        clearStreamReadTimeout();
        if (settled) {
          return;
        }
        emitProxyLine(
          deps,
          `[sidecar-proxy] upstream-close id=${proxyId} requestId=${requestId ?? '-'} complete=${upstream.complete} path=${pathname}`,
        );
        if (!res.writableEnded) {
          res.end();
        }
        settle();
      });
    },
  );

  outbound.on('error', (err) => {
    emitProxyLine(
      deps,
      `[sidecar-proxy] outbound-err id=${proxyId} requestId=${requestId ?? '-'} msg=${String(err.message).slice(0, 200)} code=${
        (err as NodeJS.ErrnoException).code ?? '-'
      }`,
    );
    if (settled) return;
    settle();
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }
    sendProxyError(res, 502, 'BRIDGE_UNREACHABLE', `Bridge connection failed: ${err.message}`);
  });

  // Propagate a client abort (Office closed the task-pane, user navigated
  // away, open SSE cancelled) to the upstream request so we don't leak
  // sockets to the bridge.
  const abortUpstream = (): void => {
    if (settled) return;
    settle();
    try {
      outbound.destroy();
    } catch {
      // Already destroyed — fine.
    }
    if (!res.writableEnded) {
      try {
        res.end();
      } catch {
        // Socket already torn down — fine.
      }
    }
  };
  req.on('close', abortUpstream);
  req.on('aborted', abortUpstream);

  if (hasRequestBody(method)) {
    if (rewrittenBody !== null) {
      outbound.end(rewrittenBody);
    } else {
      req.pipe(outbound);
    }
  } else {
    outbound.end();
  }
}

/** Narrow check: `application/json` with any params. */
function isJsonContentType(value: string | string[] | undefined): boolean {
  const raw = typeof value === 'string' ? value : value?.[0];
  if (typeof raw !== 'string') return false;
  return /^\s*application\/json\b/i.test(raw);
}

/** Upper cap on JSON bodies we will parse + stamp. Bridge schemas cap at 16KB for text;
 *  256KB gives plenty of headroom for metadata without letting a client DOS the sidecar. */
const MAX_JSON_BODY_BYTES = 256 * 1024;

/**
 * Buffer a JSON POST body (up to the cap), inject `appId: 'office-addin'` +
 * `clientId: <bridgeClientId>`, and return the re-serialised buffer. Rejects
 * if the body exceeds the cap or isn't a JSON object.
 */
async function readAndStampJsonBody(
  req: http.IncomingMessage,
  bridgeClientId: string,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_JSON_BODY_BYTES) {
      throw new Error(`body exceeds ${MAX_JSON_BODY_BYTES} bytes`);
    }
    chunks.push(buf);
  }
  // Empty body → stamp an object with just the identifiers so POST /focus
  // (which sends `{}`) still ends up validation-clean.
  const raw = total === 0 ? '{}' : Buffer.concat(chunks).toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : 'malformed JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('body must be a JSON object');
  }
  const stamped = {
    ...(parsed as Record<string, unknown>),
    appId: 'office-addin',
    clientId: bridgeClientId,
  };
  return Buffer.from(JSON.stringify(stamped), 'utf8');
}

function extractQueryString(url: string | undefined): string {
  if (!url) return '';
  const idx = url.indexOf('?');
  return idx === -1 ? '' : url.slice(idx);
}

function sendProxyError(
  res: http.ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  if (res.headersSent) return;
  const body = JSON.stringify({ success: false, error: message, code });
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body).toString(),
  });
  res.end(body);
}
