/**
 * Xero's OAuth 2.0 token endpoint, for the two grants this connector makes:
 * client credentials (a Custom Connection) and refresh token (a Web app the
 * person signed in to with "Sign in with Xero").
 *
 * Only the standard OAuth error code from a failed grant is ever used:
 * `error_description` and other fields can echo what was sent.
 */

import { z } from "zod";

export const XERO_TOKEN_URL = "https://identity.xero.com/connect/token";
export const XERO_CONNECTIONS_URL = "https://api.xero.com/connections";

const TOKEN_REQUEST_TIMEOUT_MS = 30_000;

/** The OAuth 2.0 error codes (RFC 6749 §5.2). */
const OAUTH_ERROR_CODES = [
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
] as const;

export type OAuthErrorCode = (typeof OAUTH_ERROR_CODES)[number];

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type?: string;
  refresh_token?: string;
}

export type TokenGrantFailure =
  | { kind: "timeout" }
  | { kind: "network" }
  | { kind: "http"; status: number; code?: OAuthErrorCode }
  | { kind: "malformed"; status: number };

export type TokenGrantResult =
  | { ok: true; token: TokenResponse }
  | { ok: false; failure: TokenGrantFailure };

export interface ClientKeys {
  clientId: string;
  clientSecret: string;
}

function parseTokenResponse(data: unknown): TokenResponse | null {
  const d = data as Partial<TokenResponse> | null;
  if (typeof d?.access_token !== "string" || d.access_token.length === 0) return null;
  if (typeof d.expires_in !== "number" || !(d.expires_in > 0)) return null;
  if (d.refresh_token !== undefined && (typeof d.refresh_token !== "string" || d.refresh_token.length === 0)) {
    return null;
  }
  return {
    access_token: d.access_token,
    expires_in: d.expires_in,
    token_type: typeof d.token_type === "string" ? d.token_type : undefined,
    refresh_token: d.refresh_token,
  };
}

async function oauthErrorCode(response: Response): Promise<OAuthErrorCode | undefined> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return undefined;
  }
  const error = (body as { error?: unknown } | null)?.error;
  return OAUTH_ERROR_CODES.find((code) => code === error);
}

/** One refresh-token grant. Holds no state; the caller adopts the result. */
export async function requestRefreshGrant(
  keys: ClientKeys,
  refreshToken: string,
): Promise<TokenGrantResult> {
  const authHeader =
    "Basic " + Buffer.from(`${keys.clientId}:${keys.clientSecret}`).toString("base64");
  let response: Response;
  try {
    response = await fetch(XERO_TOKEN_URL, {
      method: "POST",
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }).toString(),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      return { ok: false, failure: { kind: "timeout" } };
    }
    return { ok: false, failure: { kind: "network" } };
  }

  if (!response.ok) {
    return {
      ok: false,
      failure: { kind: "http", status: response.status, code: await oauthErrorCode(response) },
    };
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return { ok: false, failure: { kind: "malformed", status: response.status } };
  }
  const token = parseTokenResponse(data);
  if (!token) {
    return { ok: false, failure: { kind: "malformed", status: response.status } };
  }
  return { ok: true, token };
}

/** The words a person sees when a refresh-token grant fails. */
export function describeRefreshFailure(failure: TokenGrantFailure): string {
  switch (failure.kind) {
    case "timeout":
      return "Xero did not answer in time. Please try again.";
    case "network":
      return "Could not reach Xero. Please check your network connection and try again.";
    case "malformed":
      return `Xero sent back an unexpected answer (HTTP ${failure.status}). Please try again.`;
    case "http":
      if (failure.code === "invalid_grant") {
        return "Your Xero sign-in has expired or was revoked. Open Xero in Rebel's connector settings and click Connect to sign in again.";
      }
      if (failure.code === "invalid_client" || failure.code === "unauthorized_client") {
        return "Xero did not accept the Client ID and Client Secret. Check them in Rebel's Xero connector settings, then click Connect to sign in again.";
      }
      if (failure.status === 429) {
        return "Xero is rate limiting sign-in requests. Please try again in a moment.";
      }
      return `Xero refused to renew the sign-in (HTTP ${failure.status}${failure.code ? `, ${failure.code}` : ""}). Click Connect on the Xero connector to sign in again.`;
    default: {
      const unreachable: never = failure;
      return unreachable;
    }
  }
}

const connectionsSchema = z.array(
  z.object({ tenantId: z.string().min(1), tenantType: z.string().optional() }),
);

/**
 * The first Xero company (tenant) this access token can reach, or "" when none.
 * Organisations come before other tenant kinds, since the Accounting API needs
 * one. Every failure is a fixed message: Xero's body text never reaches it.
 */
export async function fetchFirstTenantId(accessToken: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(XERO_CONNECTIONS_URL, {
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
  } catch (error) {
    throw new Error(
      error instanceof Error && error.name === "TimeoutError"
        ? "Xero took too long to list your companies. Please try again."
        : "Could not reach Xero to list your companies. Please try again.",
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Could not list your Xero companies (HTTP ${response.status}).`);
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error("Xero answered the company list with something unreadable. Please try again.");
  }
  const parsed = connectionsSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error("Xero answered the company list in an unexpected shape. Please try again.");
  }
  const tenants = parsed.data;
  const organisation = tenants.find((t) => t.tenantType === "ORGANISATION");
  return (organisation ?? tenants[0])?.tenantId ?? "";
}
