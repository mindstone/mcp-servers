import axios from "axios";
import dotenv from "dotenv";
import {
  IXeroClientConfig,
  Organisation,
  TokenSet,
  XeroClient,
} from "xero-node";

import { formatError } from "../helpers/format-error.js";
import {
  findMissingScopes,
  isInvalidScopeError,
} from "../helpers/find-missing-scopes.js";
import {
  formatMissingScopesMessage,
  formatTokenRequestError,
} from "../helpers/format-token-error.js";
import { XERO_CUSTOM_CONNECTION_SCOPE } from "./xero-scopes.js";
import { bridgeRequest } from "../auth/bridge.js";
import {
  ClientKeys,
  TokenGrantFailure,
  describeRefreshFailure,
  fetchFirstTenantId,
  requestRefreshGrant,
} from "../auth/token-grant.js";

dotenv.config();

const client_id = process.env.XERO_CLIENT_ID;
const client_secret = process.env.XERO_CLIENT_SECRET;
const bearer_token = process.env.XERO_CLIENT_BEARER_TOKEN;
const refresh_token = process.env.XERO_REFRESH_TOKEN;
const grant_type = "client_credentials";

/**
 * How this connector signs in to Xero, first match wins:
 * - "bearer": XERO_CLIENT_BEARER_TOKEN, used as given.
 * - "refresh-token": a Web app the person signed in to ("Sign in with Xero"),
 *   whose refresh token the host saved as XERO_REFRESH_TOKEN.
 * - "custom-connection": a Xero Custom Connection (client credentials).
 */
export type XeroAuthMode = "bearer" | "refresh-token" | "custom-connection";

export const xeroAuthMode: XeroAuthMode = bearer_token
  ? "bearer"
  : refresh_token && client_id && client_secret
    ? "refresh-token"
    : "custom-connection";

if (!bearer_token && (!client_id || !client_secret)) {
  throw Error("Environment Variables not set - please check your .env file");
}

export abstract class MCPXeroClient extends XeroClient {
  public tenantId: string;
  private shortCode: string;

  protected constructor(config?: IXeroClientConfig) {
    super(config);
    this.tenantId = "";
    this.shortCode = "";
  }

  public abstract authenticate(): Promise<void>;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override async updateTenants(fullOrgDetails?: boolean): Promise<any[]> {
    await super.updateTenants(fullOrgDetails);
    // The latest list decides: a company this token no longer reaches must not
    // linger from an earlier lookup.
    this.tenantId = this.tenants?.[0]?.tenantId ?? "";
    return this.tenants;
  }

  private async getOrganisation(): Promise<Organisation> {
    await this.authenticate();

    const organisationResponse = await this.accountingApi.getOrganisations(
      this.tenantId || "",
    );

    const organisation = organisationResponse.body.organisations?.[0];

    if (!organisation) {
      throw new Error("Failed to retrieve organisation");
    }

    return organisation;
  }

  public async getShortCode(): Promise<string | undefined> {
    if (!this.shortCode) {
      try {
        const organisation = await this.getOrganisation();
        this.shortCode = organisation.shortCode ?? "";
      } catch (error: unknown) {
        throw new Error(
          `Failed to get Organisation short code: ${formatError(error)}`,
        );
      }
    }
    return this.shortCode;
  }
}

/**
 * Xero refused the client-credentials grant for these keys. A Web app's keys
 * get this (only a Custom Connection may use that grant), so "Sign in with
 * Xero" is the way in.
 */
export class XeroClientCredentialsRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XeroClientCredentialsRefusedError";
  }
}

function isClientCredentialsRefused(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  const code = (error.response?.data as { error?: unknown } | undefined)?.error;
  return code === "unauthorized_client" || code === "invalid_client";
}

export class CustomConnectionsXeroClient extends MCPXeroClient {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private tokenObtainedAt: number = 0;
  private tokenExpiresInMs: number = 0;

  private static readonly REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before expiry

  constructor(config: {
    clientId: string;
    clientSecret: string;
    grantType: string;
  }) {
    super(config);
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
  }

  private isTokenValid(): boolean {
    if (this.tokenExpiresInMs === 0) return false;
    const elapsed = Date.now() - this.tokenObtainedAt;
    return elapsed < this.tokenExpiresInMs - CustomConnectionsXeroClient.REFRESH_BUFFER_MS;
  }

  private requestToken(scope: string, signal?: AbortSignal) {
    const credentials = Buffer.from(
      `${this.clientId}:${this.clientSecret}`,
    ).toString("base64");
    return axios.post(
      "https://identity.xero.com/connect/token",
      `grant_type=client_credentials&scope=${encodeURIComponent(scope)}`,
      {
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        // Never follow a redirect with the app's keys (see token-grant.ts).
        maxRedirects: 0,
        signal,
      },
    );
  }

  public async getClientCredentialsToken(): Promise<TokenSet> {
    try {
      const response = await this.requestToken(XERO_CUSTOM_CONNECTION_SCOPE);

      // Get the tenant ID from the connections endpoint
      const token = response.data.access_token;
      const connectionsResponse = await axios.get(
        "https://api.xero.com/connections",
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
          },
          maxRedirects: 0,
        },
      );

      if (connectionsResponse.data && connectionsResponse.data.length > 0) {
        this.tenantId = connectionsResponse.data[0].tenantId;
      }

      return response.data;
    } catch (error) {
      if (isInvalidScopeError(error)) {
        const missing = await findMissingScopes((scope, signal) =>
          this.requestToken(scope, signal),
        );
        if (missing) throw new Error(formatMissingScopesMessage(missing));
      }
      if (isClientCredentialsRefused(error)) {
        throw new XeroClientCredentialsRefusedError(formatTokenRequestError(error));
      }
      throw new Error(formatTokenRequestError(error));
    }
  }

  public async authenticate() {
    if (this.isTokenValid()) return;

    const tokenResponse = await this.getClientCredentialsToken();

    this.tokenObtainedAt = Date.now();
    if (tokenResponse.expires_in) {
      this.tokenExpiresInMs = tokenResponse.expires_in * 1000;
    }

    this.setTokenSet({
      access_token: tokenResponse.access_token,
      expires_in: tokenResponse.expires_in,
      token_type: tokenResponse.token_type,
    });
  }
}

/** A refresh-token grant that failed; `failure` says why, in standard OAuth terms. */
export class XeroRefreshError extends Error {
  constructor(public readonly failure: TokenGrantFailure) {
    super(describeRefreshFailure(failure));
    this.name = "XeroRefreshError";
  }
}

/** Where the host saves a rotated refresh token, so a restart keeps the sign-in. */
export const UPDATE_REFRESH_TOKEN_PATH = "/bundled/xero/update-refresh-token";

function persistRotatedRefreshToken(refreshToken: string): void {
  bridgeRequest(UPDATE_REFRESH_TOKEN_PATH, { refreshToken })
    .then((result) => {
      if (!result.success) {
        console.error(
          `Xero: the renewed sign-in was not saved (${result.error ?? "no reason given"}); it lasts until this connector restarts.`,
        );
      }
    })
    .catch((error: unknown) => {
      console.error(
        `Xero: the renewed sign-in was not saved (${error instanceof Error ? error.name : "unknown error"}); it lasts until this connector restarts.`,
      );
    });
}

/**
 * A Xero Web app the person signed in to. Xero access tokens last 30 minutes
 * and every refresh hands back a new refresh token, so refreshes run one at
 * a time and each new refresh token is adopted at once and sent to the host.
 */
export class RefreshTokenXeroClient extends MCPXeroClient {
  private static readonly REFRESH_BUFFER_MS = 5 * 60 * 1000;

  private readonly keys: ClientKeys;
  private currentRefreshToken: string;
  private accessToken = "";
  private accessExpiresAt = 0;
  private inflight: Promise<void> | null = null;

  constructor(keys: ClientKeys, refreshToken: string) {
    super();
    this.keys = keys;
    this.currentRefreshToken = refreshToken;
  }

  /**
   * Ready means a live access token and a resolved company. A caller that
   * arrives while a refresh or company lookup is running waits for it.
   */
  async authenticate(): Promise<void> {
    if (this.inflight) return this.inflight;
    if (this.tenantId && !this.accessTokenNeedsRefresh()) return;
    this.inflight = this.refresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private accessTokenNeedsRefresh(): boolean {
    return Date.now() >= this.accessExpiresAt - RefreshTokenXeroClient.REFRESH_BUFFER_MS;
  }

  private async refresh(): Promise<void> {
    if (this.accessTokenNeedsRefresh()) {
      const result = await requestRefreshGrant(this.keys, this.currentRefreshToken);
      if (!result.ok) throw new XeroRefreshError(result.failure);

      const { token } = result;
      const rotated = !!token.refresh_token && token.refresh_token !== this.currentRefreshToken;
      if (token.refresh_token) this.currentRefreshToken = token.refresh_token;
      this.setTokenSet({
        access_token: token.access_token,
        expires_in: token.expires_in,
        token_type: token.token_type,
        refresh_token: this.currentRefreshToken,
      });
      this.accessToken = token.access_token;
      this.accessExpiresAt = Date.now() + token.expires_in * 1000;
      if (rotated) persistRotatedRefreshToken(this.currentRefreshToken);
    }

    // A failed lookup leaves tenantId empty, so the next call looks again
    // with the same access token (and the refresh token it already adopted).
    if (!this.tenantId) {
      const tenantId = await fetchFirstTenantId(this.accessToken);
      if (!tenantId) {
        throw new Error(
          "Your Xero sign-in has no company connected. Click Connect on the Xero connector and pick a company on Xero's page.",
        );
      }
      this.tenantId = tenantId;
    }
  }
}

class BearerTokenXeroClient extends MCPXeroClient {
  private readonly bearerToken: string;

  constructor(config: { bearerToken: string }) {
    super();
    this.bearerToken = config.bearerToken;
  }

  async authenticate(): Promise<void> {
    this.setTokenSet({
      access_token: this.bearerToken,
    });

    await this.updateTenants();
  }
}

function createClient(): MCPXeroClient {
  switch (xeroAuthMode) {
    case "bearer":
      return new BearerTokenXeroClient({ bearerToken: bearer_token! });
    case "refresh-token":
      return new RefreshTokenXeroClient(
        { clientId: client_id!, clientSecret: client_secret! },
        refresh_token!,
      );
    case "custom-connection":
      return new CustomConnectionsXeroClient({
        clientId: client_id!,
        clientSecret: client_secret!,
        grantType: grant_type,
      });
  }
}

export const xeroClient = createClient();
