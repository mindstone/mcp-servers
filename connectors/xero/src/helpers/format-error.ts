import { AxiosError } from "axios";

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

/**
 * Format error messages for return to the LLM.
 *
 * Never stringify unknown error objects. The xero-node SDK rejects with a
 * plain object whose request headers can contain bearer tokens, so only
 * whitelisted response fields are exposed.
 */
export function formatError(error: unknown): string {
  if (error instanceof AxiosError) {
    const status = error.response?.status;

    if (status !== undefined) {
      const mapped = formatHttpStatus(status);
      if (mapped) return mapped;

      return formatXeroResponseBody(status, error.response?.data);
    }
    return "An error occurred while communicating with Xero.";
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
    const mapped = formatHttpStatus(status);
    if (mapped) return mapped;

    return formatXeroResponseBody(status, getXeroBody(error.response));
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "An unexpected error occurred while communicating with Xero.";
}
