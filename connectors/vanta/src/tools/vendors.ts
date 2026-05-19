import { z } from 'zod';

import { VantaApiError, stringifyToolResult, toToolErrorResponse, validateDocumentUrl, type VantaApiClient } from '../api.js';

export const listVendorsSchema = z.object({
  category: z.string().optional().describe('Filter by vendor category'),
  status: z.string().optional().describe('Filter by vendor status'),
  page_size: z.number().int().min(1).max(500).optional().default(25).describe('Number of vendors to return, up to 500'),
  page_cursor: z.string().optional().describe('Cursor from a previous response for the next page'),
});

export const getVendorSchema = z.object({
  vendor_id: z.string().min(1).describe('Vanta vendor ID returned by vanta_list_vendors'),
});

export const createVendorSchema = z.object({
  vendor_name: z.string().min(1).describe('Name of the vendor'),
  vendor_website: z.string().min(1).describe('Website URL of the vendor'),
  vendor_category: z.string().min(1).describe('Category for the vendor (e.g., INFRASTRUCTURE, SOFTWARE, PROFESSIONAL_SERVICES)'),
  description: z.string().optional().describe('Description of the vendor relationship'),
  vendor_contact_name: z.string().optional().describe('Primary contact name at the vendor'),
  vendor_contact_email: z.string().optional().describe('Primary contact email at the vendor'),
});

export const updateVendorSchema = z.object({
  vendor_id: z.string().min(1).describe('Vanta vendor ID to update'),
  vendor_name: z.string().optional().describe('Updated vendor name'),
  vendor_website: z.string().optional().describe('Updated vendor website URL'),
  vendor_category: z.string().optional().describe('Updated vendor category'),
  description: z.string().optional().describe('Updated description'),
  vendor_contact_name: z.string().optional().describe('Updated contact name'),
  vendor_contact_email: z.string().optional().describe('Updated contact email'),
  risk_level: z.string().optional().describe('Vendor risk level (e.g., LOW, MEDIUM, HIGH, CRITICAL)'),
});

export const attachVendorDocumentSchema = z.object({
  vendor_id: z.string().min(1).describe('Vanta vendor ID to attach the document to'),
  document_name: z.string().min(1).describe('Name of the document'),
  document_url: z.string().min(1).describe('URL of the document to attach'),
  document_type: z.string().optional().describe('Type of document (e.g., SOC2_REPORT, SECURITY_QUESTIONNAIRE, CONTRACT)'),
});

export type ListVendorsArgs = z.infer<typeof listVendorsSchema>;
export type GetVendorArgs = z.infer<typeof getVendorSchema>;
export type CreateVendorArgs = z.infer<typeof createVendorSchema>;
export type UpdateVendorArgs = z.infer<typeof updateVendorSchema>;
export type AttachVendorDocumentArgs = z.infer<typeof attachVendorDocumentSchema>;

export async function vantaListVendors(
  client: VantaApiClient,
  args: ListVendorsArgs,
): Promise<string> {
  try {
    const result = await client.getPaginated('/v1/vendors', {
      category: args.category,
      status: args.status,
      page_size: args.page_size,
      page_cursor: args.page_cursor,
    });

    return stringifyToolResult({
      ok: true,
      vendors: result.data,
      count: result.data.length,
      pageInfo: result.pageInfo,
    });
  } catch (error) {
    return toToolErrorResponse(error);
  }
}

export async function vantaGetVendor(
  client: VantaApiClient,
  args: GetVendorArgs,
): Promise<string> {
  try {
    const vendor = await client.getById('/v1/vendors', args.vendor_id);
    return stringifyToolResult({ ok: true, vendor });
  } catch (error) {
    return toToolErrorResponse(error);
  }
}

export async function vantaCreateVendor(
  client: VantaApiClient,
  args: CreateVendorArgs,
): Promise<string> {
  try {
    const body: Record<string, unknown> = {
      vendorName: args.vendor_name,
      vendorWebsite: args.vendor_website,
      vendorCategory: args.vendor_category,
    };
    if (args.description !== undefined) body.description = args.description;
    if (args.vendor_contact_name !== undefined) body.vendorContactName = args.vendor_contact_name;
    if (args.vendor_contact_email !== undefined) body.vendorContactEmail = args.vendor_contact_email;

    const vendor = await client.post('/v1/vendors', body);
    return stringifyToolResult({ ok: true, vendor });
  } catch (error) {
    return toToolErrorResponse(error);
  }
}

export async function vantaUpdateVendor(
  client: VantaApiClient,
  args: UpdateVendorArgs,
): Promise<string> {
  try {
    client.validateId(args.vendor_id);
    const body: Record<string, unknown> = {};
    if (args.vendor_name !== undefined) body.vendorName = args.vendor_name;
    if (args.vendor_website !== undefined) body.vendorWebsite = args.vendor_website;
    if (args.vendor_category !== undefined) body.vendorCategory = args.vendor_category;
    if (args.description !== undefined) body.description = args.description;
    if (args.vendor_contact_name !== undefined) body.vendorContactName = args.vendor_contact_name;
    if (args.vendor_contact_email !== undefined) body.vendorContactEmail = args.vendor_contact_email;
    if (args.risk_level !== undefined) body.riskLevel = args.risk_level;

    if (Object.keys(body).length === 0) {
      throw new VantaApiError(
        'CONFIG_INVALID',
        'No update fields provided. Provide at least one field to update.',
        'The update_vendor call did not include any fields to change.',
        'Pass one or more fields (vendor_name, vendor_website, vendor_contact_name, etc.) alongside vendor_id.',
      );
    }

    const vendor = await client.put(`/v1/vendors/${encodeURIComponent(args.vendor_id)}`, body);
    return stringifyToolResult({ ok: true, vendor });
  } catch (error) {
    return toToolErrorResponse(error);
  }
}

export async function vantaAttachVendorDocument(
  client: VantaApiClient,
  args: AttachVendorDocumentArgs,
): Promise<string> {
  try {
    client.validateId(args.vendor_id);
    const safeUrl = validateDocumentUrl(args.document_url, 'document_url');
    const body: Record<string, unknown> = {
      documentName: args.document_name,
      documentUrl: safeUrl.toString(),
    };
    if (args.document_type !== undefined) body.documentType = args.document_type;

    const document = await client.post(
      `/v1/vendors/${encodeURIComponent(args.vendor_id)}/documents`,
      body,
    );
    return stringifyToolResult({ ok: true, document });
  } catch (error) {
    return toToolErrorResponse(error);
  }
}
