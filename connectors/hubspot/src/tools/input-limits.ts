export const MAX_FAN_OUT = 100;
export const MAX_STRING_BODY_LENGTH = 1_048_576;

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
