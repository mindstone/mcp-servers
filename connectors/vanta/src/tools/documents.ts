import { z } from 'zod';

import { stringifyToolResult, toToolErrorResponse, type VantaApiClient } from '../api.js';
import { buildUploadForm, fetchRemoteDocument } from '../remote-document.js';
import { sanitizeExternalText } from '../sanitize.js';

// POST /v1/documents/{documentId}/uploads — multipart/form-data, `file` required,
// `description` and `effectiveAtDate` optional. The upload attaches to an EXISTING
// Vanta document; it does not create one.
// https://developer.vanta.com/api-reference/documents/upload-file-for-document
// https://developer.vanta.com/docs/guides/upload-a-document (verified 2026-07-29)
export const uploadDocumentSchema = z.object({
  document_id: z.string().min(1).describe('ID of the existing Vanta document to attach the file to, as returned by the Vanta Documents page (e.g. access-requests)'),
  document_url: z.string().min(1).describe('Public https:// URL of the file to upload; the connector downloads it and forwards the bytes to Vanta'),
  description: z.string().optional().describe('Description stored alongside the uploaded file'),
  effective_at_date: z.string().optional().describe('Date the evidence became effective, e.g. 2026-07-01'),
  file_name: z.string().optional().describe('File name to store in Vanta; defaults to the name from the URL or Content-Disposition header'),
});

export type UploadDocumentArgs = z.infer<typeof uploadDocumentSchema>;

export async function vantaUploadDocument(
  client: VantaApiClient,
  args: UploadDocumentArgs,
): Promise<string> {
  try {
    client.validateId(args.document_id);
    const document = await fetchRemoteDocument(args.document_url, { fileName: args.file_name });
    const form = buildUploadForm(document, {
      description: args.description,
      effectiveAtDate: args.effective_at_date,
    });

    const upload = await client.postMultipart(
      `/v1/documents/${encodeURIComponent(args.document_id)}/uploads`,
      form,
    );

    return stringifyToolResult({
      ok: true,
      upload: sanitizeExternalText(upload),
      file_name: document.fileName,
      content_type: document.contentType,
      size_bytes: document.bytes.byteLength,
      // Vanta files an API upload as a draft. Reporting plain success here would
      // leave the caller believing auditors can see evidence that they cannot.
      submission_required: true,
      submission_note: 'Vanta stores this upload as a draft. Submit the document for review in Vanta before auditors can see it.',
    });
  } catch (error) {
    return toToolErrorResponse(error);
  }
}
