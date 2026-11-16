import axios from "axios";

import { XERO_CUSTOM_CONNECTION_SCOPE_MESSAGE } from "../clients/xero-scopes.js";
import { isInvalidScopeError } from "./find-missing-scopes.js";

const SCOPE_FIX_PREFIX =
  "Go to https://developer.xero.com/app/manage, select your app, ";

const REQUIRED_SCOPE_MESSAGE =
  "Xero authentication failed: your Custom Connection is missing required scopes. " +
  SCOPE_FIX_PREFIX +
  "and ensure these scopes are enabled: " +
  XERO_CUSTOM_CONNECTION_SCOPE_MESSAGE;

/** The setup guidance when the missing scopes are known exactly. */
export function formatMissingScopesMessage(missing: readonly string[]): string {
  if (missing.length === 0) return REQUIRED_SCOPE_MESSAGE;
  const noun = missing.length === 1 ? "scope" : "scopes";
  return (
    `Xero authentication failed: your Custom Connection is missing ${missing.length} ${noun}: ` +
    `${missing.join(", ")}. ` +
    SCOPE_FIX_PREFIX +
    `tick ${missing.length === 1 ? "it" : "them"} and save. Xero then switches the connection off until it is authorised again, ` +
    "so have it authorised again and then try again. " +
    "All other scopes are already set up."
  );
}

export function formatTokenRequestError(error: unknown): string {
  if (!axios.isAxiosError(error)) {
    return "Xero authentication failed. Please check your Xero connection details.";
  }

  if (isInvalidScopeError(error)) {
    return REQUIRED_SCOPE_MESSAGE;
  }

  const status = error.response?.status;
  switch (status) {
    case 401:
      return "Xero authentication failed. Please check your Xero client ID and client secret.";
    case 403:
      return "Xero authentication failed. The Xero connection does not have permission for the requested scopes.";
    case 429:
      return "Xero authentication failed because Xero rate limited the token request. Please try again in a moment.";
    default:
      if (status !== undefined) {
        return `Xero authentication failed with HTTP ${status}. Please check your Xero connection details.`;
      }
      return "Xero authentication failed before Xero returned a response. Please check your network connection and connection details.";
  }
}
