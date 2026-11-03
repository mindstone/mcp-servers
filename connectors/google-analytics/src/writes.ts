/**
 * Shared plumbing for the Admin API write tools.
 *
 * Every write goes through `adminWrite`, which enforces the GA4_ALLOW_WRITES
 * opt-in before any request leaves the process (invariant #7), validates the
 * response at the boundary, and envelopes the returned resource (invariant #6).
 */

import { z } from 'zod';
import { assertResourceIdSegment, googleApi, paginate, propertyPath, Bases } from './client.js';
import { GoogleAnalyticsError, WRITES_ENV_VAR, writesEnabled } from './types.js';
import { wrapUntrustedJsonStrings } from './untrusted-content.js';
import { compactObject, parseApiResponse, UNTRUSTED_SOURCES } from './utils.js';

/** Annotations for every tool that changes GA4 configuration. */
export const WRITE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

/** Annotations for read tools that live alongside the writes. */
export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/** Description suffix shared by every write tool. */
export const WRITE_NOTE = `Changes live GA4 configuration. Requires ${WRITES_ENV_VAR}=true and the Editor role on the property.`;

export const propertyIdArg = z
  .string()
  .describe('GA4 property ID, with or without the properties/ prefix.');

export const optionalPropertyIdArg = z
  .string()
  .optional()
  .describe(
    'GA4 property ID, with or without the properties/ prefix. Falls back to GA4_PROPERTY_ID. Ignored when the resource is passed as a full resource name.',
  );

/**
 * Removal tools take `confirm: true` so a host or model cannot remove
 * configuration by passing only an ID.
 */
export const confirmArg = z
  .literal(true)
  .describe('Must be true. Confirms the removal of this resource.');

export function assertWritesEnabled(): void {
  if (!writesEnabled()) {
    throw new GoogleAnalyticsError(
      'Write tools are disabled for this connector.',
      'WRITES_DISABLED',
      `Set ${WRITES_ENV_VAR}=true in the MCP server environment to allow changes to GA4 configuration, and mint credentials with the analytics.edit scope.`,
    );
  }
}

const resourceSchema = z.object({ name: z.string().optional() }).passthrough();

/**
 * Resolve a resource that lives directly under a property, accepting a bare
 * ID or the full `properties/<p>/<collection>/<id>` name.
 */
export function propertyChildPath(
  propertyId: string | undefined,
  value: string,
  collection: string,
  label: string,
): string {
  const full = new RegExp(`^properties/([A-Za-z0-9_-]+)/${collection}/([A-Za-z0-9_-]+)$`).exec(
    value,
  );
  if (full) return `properties/${full[1]}/${collection}/${full[2]}`;
  return `${propertyPath(propertyId)}/${collection}/${assertResourceIdSegment(value, label)}`;
}

/** Resolve a data stream, accepting a bare ID or its full resource name. */
export function dataStreamPath(propertyId: string | undefined, stream: string): string {
  return propertyChildPath(propertyId, stream, 'dataStreams', 'data stream ID');
}

/**
 * Resolve a resource that lives under a data stream, accepting a bare ID or
 * the full `properties/<p>/dataStreams/<s>/<collection>/<id>` name.
 */
export function streamChildPath(
  propertyId: string | undefined,
  stream: string,
  value: string,
  collection: string,
  label: string,
): string {
  const full = new RegExp(
    `^properties/([A-Za-z0-9_-]+)/dataStreams/([A-Za-z0-9_-]+)/${collection}/([A-Za-z0-9_-]+)$`,
  ).exec(value);
  if (full) return `properties/${full[1]}/dataStreams/${full[2]}/${collection}/${full[3]}`;
  return `${dataStreamPath(propertyId, stream)}/${collection}/${assertResourceIdSegment(value, label)}`;
}

/**
 * Build a PATCH body plus its update mask from the fields the caller set.
 * `maskOverrides` maps a body key to the mask path(s) Google expects when
 * they differ (nested fields such as `webStreamData.defaultUri`).
 */
export function buildPatch(
  fields: Record<string, unknown>,
  maskOverrides: Record<string, string> = {},
): { body: Record<string, unknown>; updateMask: string } {
  const body = compactObject(fields) as Record<string, unknown>;
  const keys = Object.keys(body);
  if (keys.length === 0) {
    throw new GoogleAnalyticsError(
      'No fields to update were provided.',
      'NOTHING_TO_UPDATE',
      'Pass at least one field to change. Unset fields are left as they are.',
    );
  }
  return { body, updateMask: keys.map((key) => maskOverrides[key] ?? key).join(',') };
}

interface AdminWriteOptions {
  method: 'POST' | 'PATCH' | 'DELETE';
  path: string;
  /** Short label for the change, echoed back to the caller. */
  action: string;
  body?: unknown;
  query?: Record<string, string | undefined>;
  alpha?: boolean;
}

/**
 * Perform one Admin API write and return the tool's JSON payload. The
 * resource name stays raw so it can be passed to later tools; the rest of
 * the resource is user-authored configuration and is enveloped wholesale.
 */
export async function adminWrite(options: AdminWriteOptions): Promise<string> {
  assertWritesEnabled();
  const response = await googleApi(`/${options.path}`, {
    method: options.method,
    body: options.body,
    query: options.query,
    baseUrl: options.alpha ? Bases.adminAlpha : Bases.admin,
  });

  // DELETE returns an empty body (Empty) for most collections.
  if (response === null || response === undefined) {
    return JSON.stringify({ ok: true, action: options.action, name: options.path });
  }

  const resource = parseApiResponse(resourceSchema, response, options.action);
  const name =
    resource.name && /^[A-Za-z0-9_/-]+$/.test(resource.name) ? resource.name : options.path;
  return JSON.stringify({
    ok: true,
    action: options.action,
    name,
    resource: wrapUntrustedJsonStrings(resource, UNTRUSTED_SOURCES.admin),
  });
}

/** Read a single Admin API resource, enveloped the same way as writes. */
export async function adminGet(path: string, context: string, alpha = false): Promise<string> {
  const response = await googleApi(`/${path}`, {
    baseUrl: alpha ? Bases.adminAlpha : Bases.admin,
  });
  const resource = parseApiResponse(resourceSchema, response ?? {}, context);
  return JSON.stringify({
    ok: true,
    name: resource.name ?? path,
    resource: wrapUntrustedJsonStrings(resource, UNTRUSTED_SOURCES.admin),
  });
}

/**
 * List an Admin API collection in full. Each item keeps its resource name
 * raw for follow-up calls; the rest is enveloped like `adminGet`.
 */
export async function adminList(
  path: string,
  itemKey: string,
  alpha = false,
): Promise<Array<{ name: string | null; resource: unknown }>> {
  const items = await paginate(`/${path}`, {
    itemKey,
    itemSchema: resourceSchema,
    query: { pageSize: 200 },
    baseUrl: alpha ? Bases.adminAlpha : Bases.admin,
  });
  return items.map((item) => ({
    name: item.name ?? null,
    resource: wrapUntrustedJsonStrings(item, UNTRUSTED_SOURCES.admin),
  }));
}

/** Free-form JSON objects for definition blobs (audience filters, grouping rules). */
export const jsonObject = z.record(z.unknown());
