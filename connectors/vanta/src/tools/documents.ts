import { z } from 'zod';

import { stringifyToolResult, toToolErrorResponse, validateDocumentUrlWithDns, type VantaApiClient } from '../api.js';

export const uploadDocumentSchema = z.object({
  document_name: z.string().min(1).describe('Name of the evidence document'),
  document_url: z.string().min(1).describe('URL of the document to upload as evidence'),
  description: z.string().optional().describe('Description of the evidence document'),
  document_type: z.string().optional().describe('Type of document (e.g., POLICY, PROCEDURE, SCREENSHOT, REPORT)'),
});

export type UploadDocumentArgs = z.infer<typeof uploadDocumentSchema>;

export async function vantaUploadDocument(
  client: VantaApiClient,
  args: UploadDocumentArgs,
): Promise<string> {
  try {
    const safeUrl = await validateDocumentUrlWithDns(args.document_url, 'document_url');
    const body: Record<string, unknown> = {
      documentName: args.document_name,
      documentUrl: safeUrl.toString(),
    };
    if (args.description !== undefined) body.description = args.description;
    if (args.document_type !== undefined) body.documentType = args.document_type;

    const document = await client.post('/v1/documents', body);
    return stringifyToolResult({ ok: true, document });
  } catch (error) {
    return toToolErrorResponse(error);
  }
}
