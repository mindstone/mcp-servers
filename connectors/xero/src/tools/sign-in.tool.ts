import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  BRIDGE_NOT_AVAILABLE,
  BRIDGE_SIGN_IN_TIMEOUT_MS,
  bridgeRequest,
} from "../auth/bridge.js";
import { needsNewSignIn } from "../auth/token-grant.js";
import {
  XeroClientCredentialsRefusedError,
  XeroRefreshError,
  xeroAuthMode,
  xeroClient,
} from "../clients/xero-client.js";
import { XERO_SIGN_IN_SCOPES } from "../clients/xero-scopes.js";
import { formatError } from "../helpers/format-error.js";

export const SIGN_IN_TOOL_NAME = "xero_sign_in";

/** The host's route that runs "Sign in with Xero" in the person's browser. */
export const START_AUTH_PATH = "/bundled/xero/start-auth";

/**
 * The result is a small JSON object the host reads (`status: "authenticated"`
 * or `error`), so the object itself is not wrapped in an untrusted-content
 * envelope, which would stop the host from reading it. No Xero text reaches
 * it: every word is written here, or is the host's own error, which the
 * bridge reader has already wrapped and the host unwraps for the person.
 */
type SignInResult =
  | { ok: true; status: "authenticated"; message: string }
  | { ok: false; error: string };

function signedIn(message: string): SignInResult {
  return { ok: true, status: "authenticated", message };
}

function failed(error: string): SignInResult {
  return { ok: false, error };
}

async function signInInBrowser(): Promise<SignInResult> {
  try {
    const result = await bridgeRequest(
      START_AUTH_PATH,
      { scopes: [...XERO_SIGN_IN_SCOPES] },
      BRIDGE_SIGN_IN_TIMEOUT_MS,
    );
    if (result.success) return signedIn("Signed in to Xero.");
    if (result.error === BRIDGE_NOT_AVAILABLE) {
      return failed(
        "Sign in with Xero needs Rebel. Outside Rebel, set XERO_REFRESH_TOKEN, XERO_CLIENT_BEARER_TOKEN or Custom Connection keys instead.",
      );
    }
    return failed(result.error ?? "Sign in with Xero did not finish. Please try again.");
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      return failed("Sign in with Xero took longer than 5 minutes. Please try again.");
    }
    return failed("Could not reach Rebel to sign in to Xero. Please try again.");
  }
}

/** Sign in to Xero with whichever way this connector is set up. */
export async function signInToXero(): Promise<SignInResult> {
  if (xeroAuthMode === "bearer") {
    // A bearer token cannot be renewed here, so a refused one is reported, not
    // sent to the browser; xero-node's own error text is not passed on.
    try {
      await xeroClient.authenticate();
    } catch {
      return failed("Xero did not accept the token in XERO_CLIENT_BEARER_TOKEN.");
    }
    return xeroClient.tenantId
      ? signedIn("Connected to Xero with your bearer token.")
      : failed("The token in XERO_CLIENT_BEARER_TOKEN reaches no Xero company.");
  }
  try {
    await xeroClient.authenticate();
    return signedIn(
      xeroAuthMode === "refresh-token"
        ? "Already signed in to Xero."
        : "Connected to Xero with your Custom Connection.",
    );
  } catch (error) {
    // A Web app's keys cannot use a Custom Connection's grant; an expired or
    // revoked sign-in cannot be renewed. Both mean: sign in again. A rate
    // limit or Xero outage gets its own "try again" words instead.
    if (error instanceof XeroClientCredentialsRefusedError) return signInInBrowser();
    if (error instanceof XeroRefreshError && needsNewSignIn(error.failure)) {
      return signInInBrowser();
    }
    return failed(formatError(error));
  }
}

export function registerSignInTool(server: McpServer): void {
  server.registerTool(
    SIGN_IN_TOOL_NAME,
    {
      description:
        "Sign in to Xero. Takes no parameters; call with {}. Rebel calls this when the person clicks Connect on the Xero connector. With a Xero Web app it opens Xero's sign-in page in the browser; with a Custom Connection it checks the connection works.",
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      const result = await signInToXero();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        ...(result.ok ? {} : { isError: true }),
      };
    },
  );
}
