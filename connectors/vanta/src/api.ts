const VANTA_REGIONS: Record<string, { api: string; token: string }> = {
  us: { api: 'https://api.vanta.com/v1', token: 'https://api.vanta.com/oauth/token' },
  eu: { api: 'https://api.eu.vanta.com/v1', token: 'https://api.eu.vanta.com/oauth/token' },
  aus: { api: 'https://api.aus.vanta.com/v1', token: 'https://api.aus.vanta.com/oauth/token' },
};

const resolveRegion = (region: string | undefined): { api: string; token: string } =>
  VANTA_REGIONS[(region ?? 'us').toLowerCase()] ?? VANTA_REGIONS.us;
const DEFAULT_TIMEOUT_MS = 60_000;
const MIN_TIMEOUT_MS = 5_000;
const MAX_PAGE_SIZE = 500;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 60;
const MAX_RETRIES = 3;
const DEFAULT_RESPONSE_SIZE_CAP_BYTES = 25 * 1024;
const MAX_RESPONSE_BODY_BYTES = 2 * 1024 * 1024; // 2MB pre-parse safety cap
const MAX_RETRY_AFTER_MS = 120_000; // Never wait more than 2 minutes on Retry-After
const VALID_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 min before expiry
const TOKEN_TTL_MS = 60 * 60 * 1000; // Vanta tokens last 1 hour

export type VantaApiErrorCode =
  | 'CONFIG_MISSING'
  | 'CONFIG_INVALID'
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'TIMEOUT'
  | 'NOT_FOUND'
  | 'API_ERROR'
  | 'NETWORK'
  | 'RESPONSE_INVALID';

interface VantaPageInfo {
  endCursor?: string | null;
  hasNextPage?: boolean;
}

interface VantaPaginatedEnvelope<T> {
  results?: {
    data?: T[];
    pageInfo?: VantaPageInfo;
  };
}

export interface VantaPaginatedResult<T> {
  data: T[];
  pageInfo: VantaPageInfo;
}

export class VantaApiError extends Error {
  readonly code: VantaApiErrorCode;
  readonly action_required: string;
  readonly next_step: string;
  readonly status?: number;

  constructor(
    code: VantaApiErrorCode,
    message: string,
    action_required: string,
    next_step: string,
    status?: number,
  ) {
    super(message);
    this.name = 'VantaApiError';
    this.code = code;
    this.action_required = action_required;
    this.next_step = next_step;
    this.status = status;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const parseTimeoutMs = (raw: string | undefined): number => {
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= MIN_TIMEOUT_MS ? parsed : DEFAULT_TIMEOUT_MS;
};

const normalizeEndpoint = (endpoint: string): string => {
  let normalized = endpoint.trim();
  if (!normalized.startsWith('/')) {
    normalized = `/${normalized}`;
  }
  if (normalized === '/v1') {
    return '';
  }
  if (normalized.startsWith('/v1/')) {
    return normalized.slice(3);
  }
  return normalized;
};

const snakeToCamel = (key: string): string => key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());

const DEFAULT_PARAM_MAP: Record<string, string> = {
  page_size: 'pageSize',
  page_cursor: 'pageCursor',
  status: 'statusFilter',
  category: 'categoryFilter',
  framework: 'frameworkFilter',
  severity: 'severityFilter',
  service: 'serviceFilter',
};

export function buildQueryParams(
  params: Record<string, unknown> = {},
  paramMap: Record<string, string> = {},
): URLSearchParams {
  const searchParams = new URLSearchParams();
  const mergedMap = { ...DEFAULT_PARAM_MAP, ...paramMap };

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }

    const apiKey = mergedMap[key] ?? snakeToCamel(key);
    const apiValue = key === 'page_size'
      ? String(Math.min(Number(value), MAX_PAGE_SIZE))
      : String(value);
    searchParams.set(apiKey, apiValue);
  }

  return searchParams;
}

const parseRetryAfterMs = (retryAfter: string | null): number | null => {
  if (!retryAfter) return null;
  const seconds = Number.parseFloat(retryAfter);
  if (Number.isFinite(seconds)) {
    return Math.min(Math.max(0, seconds * 1000), MAX_RETRY_AFTER_MS);
  }

  const dateMs = Date.parse(retryAfter);
  if (Number.isFinite(dateMs)) {
    return Math.min(Math.max(0, dateMs - Date.now()), MAX_RETRY_AFTER_MS);
  }

  return null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const sanitizeErrorText = (text: string): string =>
  text.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/token[=:]\s*\S+/gi, 'token=[REDACTED]');

const readErrorMessage = (body: unknown, fallback: string): string => {
  if (!isRecord(body)) return fallback;
  let raw: string | undefined;
  if (typeof body.message === 'string') raw = body.message;
  else if (typeof body.error === 'string') raw = body.error;
  else if (isRecord(body.error) && typeof body.error.message === 'string') raw = body.error.message;
  return raw ? sanitizeErrorText(raw) : fallback;
};

const parseErrorBody = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

// Cohort-mirrored SSRF guard for tools that pass a URL to Vanta's server-side
// fetcher (attach_vendor_document, upload_document). Lift-and-adapt from
// runway/src/client.ts isPrivateHostname() and napkin/src/client.ts. Blocks:
//   - non-HTTPS schemes (file:, chrome:, chrome-extension:, javascript:, data:,
//     view-source:, about:*, plain http:);
//   - localhost / loopback / IPv6 loopback;
//   - RFC1918 private ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16);
//   - 169.254.0.0/16 link-local (includes IMDS 169.254.169.254).
//
// HTTP (non-TLS) is rejected because the Vanta backend fetches the URL on
// behalf of the user — accepting an http:// URL would let an agent
// downgrade-attack their own organisation.
export function validateDocumentUrl(rawUrl: string, fieldName = 'document_url'): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new VantaApiError(
      'CONFIG_INVALID',
      `"${fieldName}" is not a valid URL.`,
      'The document URL is malformed.',
      'Pass a fully-qualified https:// URL pointing to a publicly-reachable document.',
    );
  }

  if (parsed.protocol !== 'https:') {
    throw new VantaApiError(
      'CONFIG_INVALID',
      `"${fieldName}" must use the https: protocol (received ${parsed.protocol}).`,
      `Only https:// document URLs are accepted; ${parsed.protocol} URLs are refused for safety.`,
      'Pass a publicly-reachable https:// URL.',
    );
  }

  const hostname = parsed.hostname.toLowerCase();

  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1' || hostname === '0.0.0.0') {
    throw new VantaApiError(
      'CONFIG_INVALID',
      `"${fieldName}" points at localhost.`,
      'Localhost and loopback addresses are refused.',
      'Pass a publicly-reachable https:// URL.',
    );
  }

  // IPv4 dotted-decimal blocks
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, aStr, bStr] = ipv4Match;
    const a = Number(aStr);
    const b = Number(bStr);
    if (a === 127) {
      throw new VantaApiError(
        'CONFIG_INVALID',
        `"${fieldName}" points at the loopback range (127.0.0.0/8).`,
        'Loopback IPv4 addresses are refused.',
        'Pass a publicly-reachable https:// URL.',
      );
    }
    if (a === 10) {
      throw new VantaApiError(
        'CONFIG_INVALID',
        `"${fieldName}" points at an RFC1918 private range (10.0.0.0/8).`,
        'Private-network addresses are refused.',
        'Pass a publicly-reachable https:// URL.',
      );
    }
    if (a === 192 && b === 168) {
      throw new VantaApiError(
        'CONFIG_INVALID',
        `"${fieldName}" points at an RFC1918 private range (192.168.0.0/16).`,
        'Private-network addresses are refused.',
        'Pass a publicly-reachable https:// URL.',
      );
    }
    if (a === 172 && b >= 16 && b <= 31) {
      throw new VantaApiError(
        'CONFIG_INVALID',
        `"${fieldName}" points at an RFC1918 private range (172.16.0.0/12).`,
        'Private-network addresses are refused.',
        'Pass a publicly-reachable https:// URL.',
      );
    }
    if (a === 169 && b === 254) {
      throw new VantaApiError(
        'CONFIG_INVALID',
        `"${fieldName}" points at link-local range (169.254.0.0/16, includes IMDS).`,
        'Link-local addresses, including cloud instance-metadata services, are refused.',
        'Pass a publicly-reachable https:// URL.',
      );
    }
  }

  // Bracketed IPv6 forms like [::1], [fe80::...] etc.
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    const inner = hostname.slice(1, -1);
    if (inner === '::1' || inner.startsWith('fe80:') || inner.startsWith('fc') || inner.startsWith('fd')) {
      throw new VantaApiError(
        'CONFIG_INVALID',
        `"${fieldName}" points at an IPv6 loopback, link-local, or unique-local address.`,
        'Non-public IPv6 addresses are refused.',
        'Pass a publicly-reachable https:// URL.',
      );
    }
  }

  return parsed;
}

const makeHttpError = async (response: Response): Promise<VantaApiError> => {
  const body = await parseErrorBody(response);
  const fallback = `Vanta API request failed with HTTP ${response.status}`;
  const message = readErrorMessage(body, fallback);

  if (response.status === 401 || response.status === 403) {
    return new VantaApiError(
      'AUTH',
      message,
      'The Vanta API rejected the request as unauthorized.',
      'Verify VANTA_CLIENT_ID and VANTA_CLIENT_SECRET are correct and that the OAuth client has the Manage Vanta (read-write) scope.',
      response.status,
    );
  }

  if (response.status === 404) {
    return new VantaApiError(
      'NOT_FOUND',
      message,
      'Vanta did not find a resource with that ID.',
      'Use an ID returned by a Vanta list tool and try again.',
      response.status,
    );
  }

  if (response.status === 429) {
    return new VantaApiError(
      'RATE_LIMIT',
      message,
      'Vanta rate-limited the request.',
      'Wait a moment, then retry with a smaller page_size or fewer concurrent calls.',
      response.status,
    );
  }

  return new VantaApiError(
    'API_ERROR',
    message,
    'Vanta returned an API error.',
    'Try again with narrower filters; if the problem persists, check the Vanta status page.',
    response.status,
  );
};

export const toToolErrorResponse = (error: unknown): string => {
  if (error instanceof VantaApiError) {
    return JSON.stringify({
      ok: false,
      error: error.message,
      code: error.code,
      action_required: error.action_required,
      next_step: error.next_step,
    }, null, 2);
  }

  const message = error instanceof Error ? error.message : String(error);
  return JSON.stringify({
    ok: false,
    error: message,
    code: 'API_ERROR',
    action_required: 'Vanta returned an unexpected error.',
    next_step: 'Retry the call. If the problem persists, file an issue with the connector maintainers.',
  }, null, 2);
};

export function stringifyToolResult(payload: Record<string, unknown>, maxBytes = DEFAULT_RESPONSE_SIZE_CAP_BYTES): string {
  const initial = JSON.stringify(payload, null, 2);
  if (Buffer.byteLength(initial, 'utf8') <= maxBytes) {
    return initial;
  }

  const arrayEntry = Object.entries(payload).find(([, value]) => Array.isArray(value));
  if (!arrayEntry) {
    return JSON.stringify({
      ok: payload.ok ?? true,
      truncated: true,
      truncation_hint: 'Response exceeded 25KB. Retry with a smaller page_size or narrower filters.',
      original_size_bytes: Buffer.byteLength(initial, 'utf8'),
    }, null, 2);
  }

  const [arrayKey, arrayValue] = arrayEntry as [string, unknown[]];
  let low = 0;
  let high = arrayValue.length;
  let best = 0;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = JSON.stringify({
      ...payload,
      [arrayKey]: arrayValue.slice(0, mid),
      count: mid,
      original_count: arrayValue.length,
      truncated: true,
      truncation_hint: 'Response exceeded 25KB. Retry with a smaller page_size or use page_cursor to continue.',
    }, null, 2);

    if (Buffer.byteLength(candidate, 'utf8') <= maxBytes) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return JSON.stringify({
    ...payload,
    [arrayKey]: arrayValue.slice(0, best),
    count: best,
    original_count: arrayValue.length,
    truncated: true,
    truncation_hint: 'Response exceeded 25KB. Retry with a smaller page_size or use page_cursor to continue.',
  }, null, 2);
}

export class VantaApiClient {
  private static requestTimestamps: number[] = [];

  private readonly clientId: string | undefined;
  private readonly clientSecret: string | undefined;
  private readonly baseUrl: string;
  private readonly tokenUrl: string;
  private readonly timeoutMs: number;

  private cachedToken: string | undefined;
  private tokenExpiresAt = 0;
  // Single-flight cache so N concurrent first-call tool invocations share one
  // token exchange instead of racing N parallel POST /oauth/token requests
  // (each of which would burn a slot in the 60-req/min shared rate-limit
  // counter).
  private inflightTokenRequest: Promise<string> | undefined;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.clientId = env.VANTA_CLIENT_ID?.trim() || undefined;
    this.clientSecret = env.VANTA_CLIENT_SECRET?.trim() || undefined;
    const region = resolveRegion(env.VANTA_REGION);
    this.baseUrl = region.api;
    this.tokenUrl = region.token;
    this.timeoutMs = parseTimeoutMs(env.VANTA_REQUEST_TIMEOUT_MS);
  }

  async get<T>(
    endpoint: string,
    params: Record<string, unknown> = {},
    paramMap: Record<string, string> = {},
  ): Promise<T> {
    return this.requestJson<T>(endpoint, { params, paramMap });
  }

  async post<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    return this.requestJson<T>(endpoint, { method: 'POST', body });
  }

  async put<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    return this.requestJson<T>(endpoint, { method: 'PUT', body });
  }

  async patch<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    return this.requestJson<T>(endpoint, { method: 'PATCH', body });
  }

  async getPaginated<T>(
    endpoint: string,
    params: Record<string, unknown> = {},
    paramMap: Record<string, string> = {},
  ): Promise<VantaPaginatedResult<T>> {
    const response = await this.requestJson<VantaPaginatedEnvelope<T>>(endpoint, { params, paramMap });
    const data = response.results?.data;
    if (!Array.isArray(data)) {
      throw new VantaApiError(
        'RESPONSE_INVALID',
        'Vanta returned an unexpected response shape.',
        'Vanta returned a response shape this connector does not recognize.',
        'Retry the call. If the problem persists, the connector may need to be updated for an API change.',
      );
    }

    return {
      data,
      pageInfo: response.results?.pageInfo ?? {},
    };
  }

  async getById<T>(endpoint: string, id: string): Promise<T> {
    this.validateId(id);
    try {
      return await this.get<T>(`${endpoint}/${encodeURIComponent(id)}`);
    } catch (error) {
      if (!(error instanceof VantaApiError) || error.code !== 'NOT_FOUND') {
        throw error;
      }
    }

    // Fallback: single-page scan when direct GET returns 404. Most Vanta endpoints
    // support direct GET; this covers edge cases. Full cursor pagination deferred.
    const page = await this.getPaginated<T>(endpoint, { page_size: MAX_PAGE_SIZE });
    const item = page.data.find((candidate) => this.itemMatchesId(candidate, id));
    if (!item) {
      throw new VantaApiError(
        'NOT_FOUND',
        `No Vanta item found with ID "${id}".`,
        'No Vanta resource matches the supplied ID.',
        'Call the corresponding list tool to confirm the ID exists, then retry.',
        404,
      );
    }
    return item;
  }

  validateId(id: string): void {
    if (!VALID_ID_PATTERN.test(id)) {
      throw new VantaApiError(
        'CONFIG_INVALID',
        'Vanta IDs may only contain letters, numbers, underscores, and hyphens.',
        'The supplied ID contains characters Vanta does not accept.',
        'Pass the exact ID returned by a Vanta list tool.',
      );
    }
  }

  private itemMatchesId(candidate: unknown, id: string): boolean {
    if (!isRecord(candidate)) return false;
    const idFields = ['id', 'uid', 'vulnerabilityId', 'testId', 'controlId', 'resourceId'];
    return idFields.some((field) => candidate[field] === id);
  }

  private async getAccessToken(): Promise<string> {
    if (!this.clientId || !this.clientSecret) {
      throw new VantaApiError(
        'CONFIG_MISSING',
        'Vanta OAuth credentials are not configured.',
        'VANTA_CLIENT_ID and VANTA_CLIENT_SECRET are not set.',
        'Set VANTA_CLIENT_ID and VANTA_CLIENT_SECRET environment variables (and optionally VANTA_REGION) and restart the server.',
      );
    }

    if (this.cachedToken && Date.now() < this.tokenExpiresAt - TOKEN_EXPIRY_BUFFER_MS) {
      return this.cachedToken;
    }

    // Single-flight: if a token exchange is already in progress, await it.
    if (this.inflightTokenRequest) {
      return this.inflightTokenRequest;
    }

    this.inflightTokenRequest = this.exchangeAccessToken();
    try {
      const token = await this.inflightTokenRequest;
      return token;
    } finally {
      this.inflightTokenRequest = undefined;
    }
  }

  private async exchangeAccessToken(): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(this.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'client_credentials',
          client_id: this.clientId,
          client_secret: this.clientSecret,
          scope: 'vanta-api.all:read-write',
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await parseErrorBody(response);
        const message = readErrorMessage(body, `Token request failed with HTTP ${response.status}`);
        throw new VantaApiError(
          'AUTH',
          message,
          'Vanta rejected the OAuth client-credentials token exchange.',
          'Verify VANTA_CLIENT_ID and VANTA_CLIENT_SECRET in the Vanta Developer Console; regenerate the client secret if needed.',
          response.status,
        );
      }

      const data = (await response.json()) as { access_token?: string; expires_in?: number };
      if (!data.access_token) {
        throw new VantaApiError(
          'AUTH',
          'Vanta token response missing access_token.',
          'Vanta returned a malformed token response.',
          'Regenerate your Vanta OAuth credentials in the Vanta Developer Console and try again.',
        );
      }

      this.cachedToken = data.access_token;
      const expiresInMs = (data.expires_in ?? TOKEN_TTL_MS / 1000) * 1000;
      this.tokenExpiresAt = Date.now() + expiresInMs;
      return this.cachedToken;
    } catch (error) {
      if (error instanceof VantaApiError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new VantaApiError(
          'TIMEOUT',
          'Token request timed out.',
          'The OAuth token request did not complete in time.',
          'Check network connectivity to Vanta and retry; increase VANTA_REQUEST_TIMEOUT_MS if the link is high-latency.',
        );
      }
      throw new VantaApiError(
        'NETWORK',
        error instanceof Error ? error.message : String(error),
        'A network error occurred while exchanging Vanta OAuth credentials.',
        'Check network connectivity and DNS resolution for the configured Vanta region.',
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async requestJson<T>(
    endpoint: string,
    options: {
      method?: string;
      params?: Record<string, unknown>;
      paramMap?: Record<string, string>;
      body?: Record<string, unknown>;
    } = {},
  ): Promise<T> {
    const { method = 'GET', params = {}, paramMap = {}, body } = options;
    const accessToken = await this.getAccessToken();
    const url = new URL(`${this.baseUrl}${normalizeEndpoint(endpoint)}`);
    const searchParams = buildQueryParams(params, paramMap);
    for (const [key, value] of searchParams.entries()) {
      url.searchParams.set(key, value);
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
    };
    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      await this.waitForRateLimit();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(url, {
          method,
          headers,
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: controller.signal,
        });

        if (response.status === 429 && attempt < MAX_RETRIES) {
          const retryAfterMs = parseRetryAfterMs(response.headers.get('Retry-After'));
          await sleep(retryAfterMs ?? 250 * 2 ** attempt);
          continue;
        }

        if (!response.ok) {
          throw await makeHttpError(response);
        }

        const bodyText = await response.text();
        if (Buffer.byteLength(bodyText, 'utf8') > MAX_RESPONSE_BODY_BYTES) {
          throw new VantaApiError(
            'RESPONSE_INVALID',
            `Vanta response exceeded ${MAX_RESPONSE_BODY_BYTES} bytes pre-parse limit.`,
            'Vanta returned a response larger than the connector accepts.',
            'Retry with a smaller page_size or narrower filters.',
          );
        }

        try {
          return JSON.parse(bodyText) as T;
        } catch {
          throw new VantaApiError(
            'RESPONSE_INVALID',
            'Vanta returned a non-JSON response.',
            'Vanta returned a response the connector could not parse.',
            'Retry the call. If the problem persists, the connector may need to be updated for an API change.',
          );
        }
      } catch (error) {
        if (error instanceof VantaApiError) {
          throw error;
        }
        if (error instanceof Error && error.name === 'AbortError') {
          throw new VantaApiError(
            'TIMEOUT',
            `Vanta request timed out after ${this.timeoutMs}ms.`,
            'The Vanta API call did not complete in time.',
            'Retry with a smaller page_size or narrower filters; increase VANTA_REQUEST_TIMEOUT_MS if the link is high-latency.',
          );
        }
        throw new VantaApiError(
          'NETWORK',
          error instanceof Error ? error.message : String(error),
          'A network error occurred while calling the Vanta API.',
          'Check network connectivity and retry.',
        );
      } finally {
        clearTimeout(timeout);
      }
    }

    throw new VantaApiError(
      'RATE_LIMIT',
      'Vanta rate limit retry budget exhausted.',
      'Vanta rate-limited the request beyond the retry budget.',
      'Wait a minute, then retry with a smaller page_size or fewer concurrent calls.',
      429,
    );
  }

  private async waitForRateLimit(): Promise<void> {
    const now = Date.now();
    VantaApiClient.requestTimestamps = VantaApiClient.requestTimestamps.filter(
      (timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS,
    );

    if (VantaApiClient.requestTimestamps.length >= RATE_LIMIT_MAX_REQUESTS) {
      const oldest = VantaApiClient.requestTimestamps[0] ?? now;
      await sleep(Math.max(0, RATE_LIMIT_WINDOW_MS - (now - oldest)));
    }

    VantaApiClient.requestTimestamps.push(Date.now());
  }
}
