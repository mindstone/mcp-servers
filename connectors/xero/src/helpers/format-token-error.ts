import axios from "axios";

import { XERO_CUSTOM_CONNECTION_SCOPE_MESSAGE } from "../clients/xero-scopes.js";

const REQUIRED_SCOPE_MESSAGE =
  "Xero authentication failed: your Custom Connection is missing required scopes. " +
  "Go to https://developer.xero.com/app/manage, select your app, and ensure these scopes are enabled: " +
  XERO_CUSTOM_CONNECTION_SCOPE_MESSAGE;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isInvalidScopeResponse(data: unknown): boolean {
  return isRecord(data) && data.error === "invalid_scope";
}

export function formatTokenRequestError(error: unknown): string {
  if (!axios.isAxiosError(error)) {
    return "Xero authentication failed. Please check your Xero connection details.";
  }

  const data = error.response?.data;
  if (isInvalidScopeResponse(data)) {
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
