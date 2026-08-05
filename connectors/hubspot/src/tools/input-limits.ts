export const MAX_FAN_OUT = 100;
export const MAX_STRING_BODY_LENGTH = 1_048_576;

/**
 * Bounds for a CRM read/search tool's `properties` array (DoS hardening).
 * Single source of truth shared by the input-schema cap (definitions.ts) and
 * the runtime property-name validation path (property-validation.ts) so the
 * schema-level cap and what validation actually processes stay in lockstep.
 * Generous enough not to break a legitimate "fetch all properties" request
 * (a portal has ~50-150 properties).
 */
export const MAX_REQUESTED_PROPERTIES = 200;
export const MAX_REQUESTED_PROPERTY_NAME_LENGTH = 256;

/**
 * Ready-to-spread JSON Schema fragment for a read/search `properties` array.
 * Spread into each tool's schema so all CRM reads cap identically.
 */
export const PROPERTIES_ARRAY_SCHEMA = {
  type: 'array' as const,
  items: { type: 'string' as const, maxLength: MAX_REQUESTED_PROPERTY_NAME_LENGTH },
  maxItems: MAX_REQUESTED_PROPERTIES,
};

export type InputTooLargePayload = {
  status: 'error';
  errorCode: 'INPUT_TOO_LARGE';
  message: string;
  isError: true;
  suggestion: string;
};

export const MAX_ASSOCIATION_IDS_MESSAGE = 'Maximum 100 IDs per association type per call';

function throwInputTooLarge(message: string): never {
  const payload: InputTooLargePayload = {
    status: 'error',
    errorCode: 'INPUT_TOO_LARGE',
    message,
    isError: true,
    suggestion: 'Split the request into smaller batches and retry.',
  };
  throw new Error(JSON.stringify(payload));
}

export function assertMaxFanOut(
  ids: string[] | undefined,
  fieldPath: string,
  limit = MAX_FAN_OUT,
): void {
  if (ids && ids.length > limit) {
    throwInputTooLarge(
      `${fieldPath} contains ${ids.length} IDs; maximum is ${limit} per call because HubSpot batch APIs accept up to ${limit} records. Split into batches of up to ${limit} and retry.`,
    );
  }
}

/**
 * Membership-write tools take a non-empty ID list — an empty array would be a
 * no-op write the model believes succeeded. Rejected before any API call, in
 * the same INVALID_ARGUMENTS shape as the path validators.
 */
export function assertNonEmptyIdList(ids: string[] | undefined, fieldPath: string): void {
  if (!ids || ids.length === 0) {
    throw new Error(`INVALID_ARGUMENTS: ${fieldPath} must contain at least one ID`);
  }
}

export function assertAssociationFanOut(associations: {
  contactIds?: string[];
  companyIds?: string[];
  dealIds?: string[];
  ticketIds?: string[];
} | undefined): void {
  assertMaxFanOut(associations?.contactIds, 'associations.contactIds');
  assertMaxFanOut(associations?.companyIds, 'associations.companyIds');
  assertMaxFanOut(associations?.dealIds, 'associations.dealIds');
  assertMaxFanOut(associations?.ticketIds, 'associations.ticketIds');
}

export function assertStringBodySize(
  value: string | undefined,
  fieldPath: string,
  limit = MAX_STRING_BODY_LENGTH,
): void {
  if (typeof value === 'string') {
    const byteLength = Buffer.byteLength(value, 'utf8');
    if (byteLength > limit) {
      throwInputTooLarge(
        `${fieldPath} is ${byteLength} bytes; maximum is ${limit} bytes (1 MiB). Shorten this field and retry.`,
      );
    }
  }
}

export function assertRecordStringBodySizes(
  values: Record<string, string> | undefined,
  fieldPath = 'properties',
): void {
  if (!values) {
    return;
  }

  for (const [key, value] of Object.entries(values)) {
    assertStringBodySize(value, `${fieldPath}.${key}`);
  }
}
