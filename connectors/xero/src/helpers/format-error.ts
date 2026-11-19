import axios, { AxiosError } from "axios";

import { XeroConnectorError } from "./connector-error.js";

interface XeroSdkProblem {
  title?: string;
  detail?: string;
  status?: number;
}

interface XeroSdkError {
  response: {
    status?: number;
    statusCode?: number;
    body?: unknown;
    data?: unknown;
  };
}

function isXeroSdkError(error: unknown): error is XeroSdkError {
  if (typeof error !== "object" || error === null) return false;
  const response = (error as { response?: unknown }).response;
  if (typeof response !== "object" || response === null) return false;
  return (
    typeof (response as { statusCode?: unknown }).statusCode === "number" ||
    typeof (response as { status?: unknown }).status === "number"
  );
}

function formatHttpStatus(status: number): string {
  switch (status) {
    case 401:
      return "Authentication failed. Please check your Xero credentials.";
    case 403:
      return "You don't have permission to access this resource in Xero.";
    case 404:
      return "The requested resource was not found in Xero.";
    case 429:
      return "Too many requests to Xero. Please try again in a moment.";
    default:
      return "";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getXeroBody(response: XeroSdkError["response"]): unknown {
  return response.body ?? response.data;
}

function getValidationMessages(body: unknown): string[] {
  if (!isRecord(body)) return [];

  const messages: string[] = [];
  const collectFromValidationErrors = (value: unknown) => {
    if (!Array.isArray(value)) return;

    for (const validationError of value) {
      if (!isRecord(validationError)) continue;
      const message = getString(validationError, "Message");
      if (message) messages.push(message);
    }
  };

  collectFromValidationErrors(body.ValidationErrors);

  const elements = body.Elements;
  if (Array.isArray(elements)) {
    for (const element of elements) {
      if (!isRecord(element)) continue;
      collectFromValidationErrors(element.ValidationErrors);
    }
  }

  return [...new Set(messages)];
}

function formatXeroResponseBody(status: number, body: unknown): string {
  if (!isRecord(body)) return `${status} HTTP error`;

  const problem = isRecord(body.problem)
    ? (body.problem as XeroSdkProblem & Record<string, unknown>)
    : undefined;

  const title =
    problem?.title ??
    getString(body, "Type") ??
    getString(body, "httpStatusCode") ??
    "HTTP error";

  const validationMessages = getValidationMessages(body);
  const detail =
    validationMessages.length > 0
      ? validationMessages.join("; ")
      : problem?.detail ??
        getString(body, "Detail") ??
        getString(body, "Message");

  return detail ? `${status} ${title}: ${detail}` : `${status} ${title}`;
}

function parseXeroSdkErrorString(error: string): unknown {
  try {
    const parsed = JSON.parse(error);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const TIMEOUT_MESSAGE = "Xero did not answer in time. Please try again.";
const NETWORK_MESSAGE = "Could not reach Xero. Please check the connection and try again.";

/** An axios request abandoned at its timeout. */
export function isTimeout(error: AxiosError): boolean {
  return error.code === AxiosError.ECONNABORTED || error.code === AxiosError.ETIMEDOUT;
}

/** The stand-in sdk-axios.ts rejects with when Xero gave no answer. */
function formatTransportFailure(body: unknown): string {
  return isRecord(body) && body.XeroConnectorTransportFailure === "timeout"
    ? TIMEOUT_MESSAGE
    : NETWORK_MESSAGE;
}

/**
 * A 4xx keeps Xero's own explanation (a validation message, say), which Xero
 * writes for the caller. A 5xx body is about Xero's insides, so it is dropped.
 */
function formatStatus(status: number, body: unknown): string {
  if (status === 0) return formatTransportFailure(body);
  const mapped = formatHttpStatus(status);
  if (mapped) return mapped;
  if (status >= 500) return `Xero had a problem on its side (${status}). Please try again later.`;
  return formatXeroResponseBody(status, body);
}

/**
 * Format error messages for return to the LLM.
 *
 * Never stringify unknown error objects. The xero-node SDK rejects with a
 * plain object whose request headers can contain bearer tokens, so only
 * whitelisted response fields are exposed.
 */
export function formatError(error: unknown): string {
  // isAxiosError, not instanceof: xero-node's CommonJS axios has its own class.
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    if (status !== undefined) return formatStatus(status, error.response?.data);
    return isTimeout(error) ? TIMEOUT_MESSAGE : NETWORK_MESSAGE;
  }

  if (typeof error === "string") {
    const parsed = parseXeroSdkErrorString(error);
    return isXeroSdkError(parsed)
      ? formatError(parsed)
      : "An unexpected error occurred while communicating with Xero.";
  }

  if (isXeroSdkError(error)) {
    const status = error.response.statusCode ?? error.response.status;
    if (status === undefined) {
      return "An unexpected error occurred while communicating with Xero.";
    }
    return formatStatus(status, getXeroBody(error.response));
  }

  // Only words this connector wrote are passed on. Any other error (a bug, a
  // socket error, an SDK failure) can quote internals, so it gets a fixed
  // sentence; its name goes to stderr for whoever reads the connector's log.
  if (error instanceof XeroConnectorError) {
    return error.message;
  }
  if (error instanceof Error) {
    console.error(`Xero: unexpected ${error.name}; a fixed message was returned instead.`);
  }

  return "An unexpected error occurred while communicating with Xero.";
}
