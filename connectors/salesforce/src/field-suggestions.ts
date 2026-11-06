import type jsforce from 'jsforce';
import { z } from 'zod';
import { wrapUntrusted } from './untrusted-content.js';

const LOOKUP_TIMEOUT_MS = 2_000;
const MAX_IDENTIFIER_LENGTH = 255;
const MAX_COMPARISON_LENGTH = 256;
const CLOSE_MATCH_RATIO = 0.25;
const FIELD_ERROR_FRAGMENT = /No such column '([A-Za-z][A-Za-z0-9_]*)' on entity '([A-Za-z][A-Za-z0-9_]*)'/;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;

const describeResponseSchema = z.object({
  fields: z.array(z.object({
    name: z.string(),
    label: z.string(),
  })),
});

export interface FieldSuggestionCandidate {
  name: string;
  label: string;
}

export interface FieldSuggestions {
  object: string;
  requested_field: string;
  candidates: FieldSuggestionCandidate[];
  note: string;
}

type DiagnosticResult = 'ok' | 'session-expired' | 'failed';
type LookupFailureCategory = 'timeout' | 'session' | 'invalid metadata' | 'other';

const fieldSuggestions = new WeakMap<Error, FieldSuggestions>();

function isBoundedIdentifier(value: string): boolean {
  return value.length <= MAX_IDENTIFIER_LENGTH && IDENTIFIER.test(value);
}

function isSessionExpired(error: unknown): boolean {
  return error instanceof Error && (
    ('errorCode' in error && error.errorCode === 'INVALID_SESSION_ID') ||
    error.message.includes('INVALID_SESSION_ID') ||
    error.message.includes('Session expired')
  );
}

function lookupFailureCategory(error: unknown): LookupFailureCategory {
  if (isSessionExpired(error)) return 'session';
  if (error instanceof Error && error.message === 'field suggestion diagnostic deadline exceeded') return 'timeout';
  if (error instanceof z.ZodError) return 'invalid metadata';
  return 'other';
}

function logLookupFailure(category: LookupFailureCategory): void {
  console.error(`[Salesforce MCP] Field suggestion lookup failed (${category})`);
}

/**
 * Make API names and labels comparable while treating Salesforce naming
 * conventions as equivalent. Comparison strings are bounded before distance
 * work; the original API name is retained for the returned candidate.
 */
function normaliseForComparison(value: string): string | null {
  const withCamelBoundaries = value.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  const withoutCustomSuffix = withCamelBoundaries.replace(/__c$/i, '');
  const normalised = withoutCustomSuffix.toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalised.length > 0 && normalised.length <= MAX_COMPARISON_LENGTH ? normalised : null;
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    let diagonal = previous[0];
    previous[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      const above = previous[rightIndex];
      previous[rightIndex] = left[leftIndex - 1] === right[rightIndex - 1]
        ? diagonal
        : Math.min(diagonal + 1, previous[rightIndex - 1] + 1, above + 1);
      diagonal = above;
    }
  }
  return previous[right.length];
}

function editRatio(left: string, right: string): number {
  return editDistance(left, right) / Math.max(left.length, right.length);
}

interface RankedCandidate extends FieldSuggestionCandidate {
  rank: [number, number, string];
}

function rankCandidates(fields: FieldSuggestionCandidate[], requestedField: string): FieldSuggestionCandidate[] {
  const requested = normaliseForComparison(requestedField);
  if (!requested) return [];

  const ranked: RankedCandidate[] = [];
  const seenNames = new Set<string>();
  for (const field of fields) {
    if (seenNames.has(field.name)) continue;
    seenNames.add(field.name);
    const name = normaliseForComparison(field.name);
    const label = normaliseForComparison(field.label);
    if (!name && !label) continue;

    const nameExact = name === requested;
    const labelExact = label === requested;
    const nameRatio = name ? editRatio(requested, name) : Number.POSITIVE_INFINITY;
    const labelRatio = label ? editRatio(requested, label) : Number.POSITIVE_INFINITY;
    const ratio = Math.min(nameRatio, labelRatio);
    if (!nameExact && !labelExact && ratio > CLOSE_MATCH_RATIO) continue;

    const kind = nameExact ? 0 : labelExact ? 1 : 2;
    ranked.push({
      ...field,
      rank: [kind, nameExact || labelExact ? 0 : ratio, field.name],
    });
  }

  ranked.sort((left, right) => {
    const nameOrder = left.rank[2] < right.rank[2] ? -1 : left.rank[2] > right.rank[2] ? 1 : 0;
    return left.rank[0] - right.rank[0] || left.rank[1] - right.rank[1] || nameOrder;
  });
  return ranked.slice(0, 3).map(({ name, label }) => ({ name, label }));
}

function settledBeforeDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('field suggestion diagnostic deadline exceeded')), timeoutMs);
  });
  // The catch observes a response that settles after the outer deadline.
  void promise.catch(() => undefined);
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function parseFieldError(error: unknown): { requestedField: string; objectName: string } | null {
  if (!(error instanceof Error) || !('errorCode' in error) || error.errorCode !== 'INVALID_FIELD') return null;
  const match = FIELD_ERROR_FRAGMENT.exec(error.message);
  if (!match || !isBoundedIdentifier(match[1]) || !isBoundedIdentifier(match[2])) return null;
  return { requestedField: match[1], objectName: match[2] };
}

/**
 * Enrich a qualifying Salesforce error without changing or replacing it.
 * Every lookup failure deliberately returns without adding a side-table entry.
 */
export async function enrichFieldError(
  conn: jsforce.Connection,
  error: unknown,
  onSessionExpired: () => void,
): Promise<DiagnosticResult> {
  const parsed = parseFieldError(error);
  if (!parsed || !(error instanceof Error)) return 'failed';

  try {
    const response = await settledBeforeDeadline(
      Promise.resolve(conn.request(
        {
          method: 'GET',
          url: `/sobjects/${parsed.objectName}/describe`,
        },
        {
          timeout: LOOKUP_TIMEOUT_MS,
          followRedirect: false,
          retry: { maxRetries: 0, methods: [] },
        },
      )) as Promise<unknown>,
      LOOKUP_TIMEOUT_MS,
    );
    const metadata = describeResponseSchema.parse(response);
    const fields: FieldSuggestionCandidate[] = [];
    for (const field of metadata.fields) {
      if (!isBoundedIdentifier(field.name)) {
        logLookupFailure('invalid metadata');
        return 'failed';
      }
      fields.push({ name: field.name, label: field.label });
    }

    if (fields.some((field) => field.name.toLowerCase() === parsed.requestedField.toLowerCase())) {
      return 'ok';
    }
    const candidates = rankCandidates(fields, parsed.requestedField);
    if (candidates.length === 0) return 'ok';

    fieldSuggestions.set(error, {
      object: parsed.objectName,
      requested_field: parsed.requestedField,
      candidates: candidates.map((candidate) => ({
        name: candidate.name,
        label: wrapUntrusted(candidate.label, 'salesforce:field_suggestion_label') ?? '',
      })),
      note: 'The field may be missing or hidden from this user. These visible fields are possible matches, not confirmed replacements.',
    });
    return 'ok';
  } catch (lookupError: unknown) {
    const sessionExpired = isSessionExpired(lookupError);
    logLookupFailure(lookupFailureCategory(lookupError));
    if (sessionExpired) onSessionExpired();
    return sessionExpired ? 'session-expired' : 'failed';
  }
}

export function getFieldSuggestions(error: unknown): FieldSuggestions | undefined {
  return error instanceof Error ? fieldSuggestions.get(error) : undefined;
}

export const _fieldSuggestionInternals = {
  normaliseForComparison,
  editRatio,
  rankCandidates,
  parseFieldError,
};
