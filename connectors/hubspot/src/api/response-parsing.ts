import { z } from 'zod';
import logger from '../utils/logger.js';

/**
 * A static description of one HubSpot reply shape. `label` names the shape in
 * diagnostics; it is a constant, never built from request input or reply data.
 */
export interface HubSpotResponseSpec<T> {
  readonly label: string;
  readonly schema: z.ZodType<T, z.ZodTypeDef, unknown>;
}

export interface HubSpotResponseIssue {
  code: string;
  path: string;
}

export type HubSpotInvalidResponseReason = 'malformed_json' | 'schema_mismatch';

const DYNAMIC_KEY_PLACEHOLDER = '<key>';
const MAX_REPORTED_ISSUES = 10;

/**
 * A 2xx HubSpot reply whose body is not JSON or does not match the expected
 * shape. Carries only connector-owned diagnostics: the static operation label,
 * the issue count, and each issue's Zod code and schema-owned path. Vendor
 * values, vendor-authored keys and Zod messages are never stored here, so the
 * error is safe to log and to classify into a tool error.
 */
export class HubSpotInvalidResponseError extends Error {
  readonly code = 'INVALID_RESPONSE';

  constructor(
    public readonly operation: string,
    public readonly reason: HubSpotInvalidResponseReason,
    public readonly issueCount: number,
    public readonly issues: HubSpotResponseIssue[],
  ) {
    super(
      reason === 'malformed_json'
        ? `HubSpot returned a reply that is not valid JSON for ${operation}`
        : `HubSpot returned an unexpected reply shape for ${operation} (${issueCount} issue(s): ${
            [...new Set(issues.map((issue) => issue.code))].join(', ')
          })`,
    );
    this.name = 'HubSpotInvalidResponseError';
  }
}

function unwrapSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  for (;;) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
      current = current.unwrap();
    } else if (current instanceof z.ZodEffects) {
      current = current.innerType();
    } else if (current instanceof z.ZodDefault) {
      current = current.removeDefault();
    } else if (current instanceof z.ZodLazy) {
      current = current.schema;
    } else {
      return current;
    }
  }
}

function unionOptions(schema: z.ZodTypeAny): z.ZodTypeAny[] | undefined {
  if (schema instanceof z.ZodUnion || schema instanceof z.ZodDiscriminatedUnion) {
    return [...schema.options] as z.ZodTypeAny[];
  }
  return undefined;
}

type Step = { owned: boolean; next: z.ZodTypeAny | undefined };

function stepInto(schema: z.ZodTypeAny | undefined, segment: string | number): Step {
  if (!schema) return { owned: false, next: undefined };
  const current = unwrapSchema(schema);
  const options = unionOptions(current);
  if (options) {
    for (const option of options) {
      const step = stepInto(option, segment);
      if (step.owned) return step;
    }
    return { owned: false, next: undefined };
  }
  if (typeof segment === 'number') {
    if (current instanceof z.ZodArray) return { owned: true, next: current.element };
    return { owned: false, next: undefined };
  }
  if (current instanceof z.ZodObject) {
    const shape = current.shape as Record<string, z.ZodTypeAny>;
    if (Object.prototype.hasOwnProperty.call(shape, segment)) {
      return { owned: true, next: shape[segment] };
    }
    return { owned: false, next: undefined };
  }
  if (current instanceof z.ZodRecord) {
    // The key is vendor data; only the value schema is ours.
    return { owned: false, next: current.valueSchema };
  }
  return { owned: false, next: undefined };
}

/**
 * Render a Zod issue path keeping only keys the schema itself declares. Any
 * other key (a record key, a key reached through an unknown shape) is vendor
 * data and becomes a placeholder; array indices stay, as they carry no data.
 */
function describeIssuePath(schema: z.ZodTypeAny, path: ReadonlyArray<string | number>): string {
  let current: z.ZodTypeAny | undefined = schema;
  const parts: string[] = [];
  for (const segment of path) {
    const step = stepInto(current, segment);
    if (typeof segment === 'number') {
      parts.push(`[${segment}]`);
    } else {
      parts.push(step.owned ? `.${segment}` : `.${DYNAMIC_KEY_PLACEHOLDER}`);
    }
    current = step.next;
  }
  return parts.length === 0 ? '(root)' : parts.join('').replace(/^\./, '');
}

function invalidResponse(
  operation: string,
  reason: HubSpotInvalidResponseReason,
  issueCount: number,
  issues: HubSpotResponseIssue[],
): HubSpotInvalidResponseError {
  const error = new HubSpotInvalidResponseError(operation, reason, issueCount, issues);
  logger.error({ operation, reason, issueCount, issues }, 'hubspot_invalid_response');
  return error;
}

/**
 * Validate a decoded reply body. `undefined` stands for "no body" (204 or an
 * empty 2xx), so only a schema that accepts undefined accepts a bodiless
 * reply: NoContentResponse (void methods) and the workflow-enrollment spec
 * (an undocumented reply, treated as an acknowledgement) do; every other spec
 * rejects it.
 */
function parseHubSpotResponseBody<T>(
  spec: HubSpotResponseSpec<T>,
  body: unknown,
  operation: string,
): T {
  const result = spec.schema.safeParse(body);
  if (result.success) return result.data;
  const issues = result.error.issues;
  throw invalidResponse(
    operation,
    'schema_mismatch',
    issues.length,
    issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => ({
      code: issue.code,
      path: describeIssuePath(spec.schema as z.ZodTypeAny, issue.path),
    })),
  );
}

/**
 * Read a successful fetch Response and parse it against `spec`. The body is
 * decoded as `unknown`; invalid JSON and a shape mismatch both throw
 * HubSpotInvalidResponseError.
 */
export async function readHubSpotResponse<T>(
  response: Response,
  spec: HubSpotResponseSpec<T>,
  operation: string,
): Promise<T> {
  const text = response.status === 204 ? '' : await response.text();
  let body: unknown;
  if (text.trim().length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      throw invalidResponse(operation, 'malformed_json', 0, []);
    }
  }
  return parseHubSpotResponseBody(spec, body, operation);
}
