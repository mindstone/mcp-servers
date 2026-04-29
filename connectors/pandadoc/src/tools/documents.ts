import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { pandadocFetch, pandadocFetchRaw } from '../client.js';
import { withErrorHandling } from '../utils.js';
import { isConfigured } from '../auth.js';
import { MAX_FILE_SIZE } from '../types.js';
import type {
  DocumentListResponse,
  DocumentCreateResponse,
  DocumentSendResponse,
} from '../types.js';

function noApiKeyError(): string {
  return JSON.stringify({
    ok: false,
    error: 'PandaDoc API key not configured',
    resolution: 'To use PandaDoc, you need to configure an API key first.',
    next_step: {
      action: 'Ask the user for their PandaDoc API key, then call configure_pandadoc_api_key',
      tool_to_call: 'configure_pandadoc_api_key',
      tool_parameters: { api_key: '<user_provided_key>' },
      get_key_from: 'PandaDoc Settings → API → Developer Dashboard. Requires Business or Enterprise plan.',
    },
  });
}

function formatDocumentCompact(doc: Record<string, unknown>): Record<string, unknown> {
  return {
    id: doc.id,
    name: doc.name,
    status: doc.status,
    date_created: doc.date_created,
    date_modified: doc.date_modified,
    expiration_date: doc.expiration_date,
    version: doc.version,
  };
}

function formatDocumentDetails(doc: Record<string, unknown>): Record<string, unknown> {
  return {
    id: doc.id,
    name: doc.name,
    status: doc.status,
    date_created: doc.date_created,
    date_modified: doc.date_modified,
    date_completed: doc.date_completed,
    date_sent: doc.date_sent,
    expiration_date: doc.expiration_date,
    version: doc.version,
    created_by: doc.created_by,
    template: doc.template,
    recipients: doc.recipients,
    fields: doc.fields,
    tokens: doc.tokens,
    metadata: doc.metadata,
    tags: doc.tags,
    grand_total: doc.grand_total,
    linked_objects: doc.linked_objects,
  };
}

function paginationHint(count: number, page: number, pageSize: number): string {
  if (count < pageSize) return `Showing all ${count} results.`;
  return `Showing ${count} results (page ${page}). Use page=${page + 1} to see more.`;
}

export function registerDocumentTools(server: McpServer): void {
  // ── list_documents ──────────────────────────────────────────────────
  server.registerTool(
    'list_documents',
    {
      description:
        `List and search PandaDoc documents with filtering.

Supports filtering by status, template, name/reference, tags, metadata, date ranges, and more.
Returns compact summaries: id, name, status, dates.

Status codes: 0=draft, 1=sent, 2=completed, 3=uploaded, 4=error, 5=viewed,
6=waiting_approval, 7=approved, 8=rejected, 9=waiting_pay, 10=paid, 11=voided, 12=declined

RELATED TOOLS:
- get_document_details: Get full details for a specific document
- get_document_status: Quick status check by document ID`,
      inputSchema: z.object({
        q: z.string().optional().describe('Search by document name or reference number'),
        status: z.number().optional().describe('Filter by status code (0=draft, 1=sent, 2=completed, etc.)'),
        template_id: z.string().optional().describe('Filter by parent template ID'),
        folder_uuid: z.string().optional().describe('Filter by folder ID'),
        tag: z.string().optional().describe('Filter by tag'),
        created_from: z.string().optional().describe('Documents created on or after this date (ISO 8601)'),
        created_to: z.string().optional().describe('Documents created before this date (ISO 8601)'),
        order_by: z.string().optional().describe('Sort field. Prefix with - for DESC (e.g., "-date_created"). Default: date_status_changed'),
        count: z.number().min(1).max(100).default(50).describe('Results per page (default 50, max 100)'),
        page: z.number().min(1).default(1).describe('Page number (starts at 1)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return noApiKeyError();

      const params = new URLSearchParams();
      params.set('count', String(args.count));
      params.set('page', String(args.page));

      if (args.q) params.set('q', args.q);
      if (args.status !== undefined) params.set('status', String(args.status));
      if (args.template_id) params.set('template_id', args.template_id);
      if (args.folder_uuid) params.set('folder_uuid', args.folder_uuid);
      if (args.tag) params.set('tag', args.tag);
      if (args.created_from) params.set('created_from', args.created_from);
      if (args.created_to) params.set('created_to', args.created_to);
      if (args.order_by) params.set('order_by', args.order_by);

      const result = await pandadocFetch<DocumentListResponse>(
        `/documents?${params.toString()}`,
      );

      const documents = (result.results || []).map(formatDocumentCompact);
      const hint = paginationHint(documents.length, args.page, args.count);

      return JSON.stringify({ ok: true, documents, count: documents.length, pagination: hint });
    }),
  );

  // ── get_document_status ─────────────────────────────────────────────
  server.registerTool(
    'get_document_status',
    {
      description:
        `Check the current status of a PandaDoc document.

Returns: id, name, status, dates. Lightweight alternative to get_document_details.
Use this to poll after upload/creation until status changes to 'document.draft'.

Status values: document.uploaded, document.draft, document.sent, document.completed,
document.viewed, document.waiting_approval, document.approved, document.rejected,
document.waiting_pay, document.paid, document.voided, document.declined, document.error

WORKFLOW — After upload:
1. Upload returns status 'document.uploaded'
2. Poll this tool every 2-3 seconds
3. When status is 'document.draft', the document is ready to send`,
      inputSchema: z.object({
        document_id: z.string().min(1).describe('The document ID'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return noApiKeyError();

      const result = await pandadocFetch<Record<string, unknown>>(
        `/documents/${encodeURIComponent(args.document_id)}`,
      );

      return JSON.stringify({ ok: true, document: formatDocumentCompact(result) });
    }),
  );

  // ── get_document_details ────────────────────────────────────────────
  server.registerTool(
    'get_document_details',
    {
      description:
        `Get full details for a PandaDoc document.

Returns comprehensive data: recipients, fields, tokens, pricing, metadata, tags, linked objects, and more.
Use this to inspect a document's content and state before sending or after completion.

RELATED TOOLS:
- list_documents: Find document IDs
- get_document_status: Quick status check (lighter weight than full details)
- send_document: Send the document for signing`,
      inputSchema: z.object({
        document_id: z.string().min(1).describe('The document ID'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return noApiKeyError();

      const result = await pandadocFetch<Record<string, unknown>>(
        `/documents/${encodeURIComponent(args.document_id)}/details`,
      );

      return JSON.stringify({ ok: true, document: formatDocumentDetails(result) });
    }),
  );

  // ── create_document_from_template ───────────────────────────────────
  server.registerTool(
    'create_document_from_template',
    {
      description:
        `Create a new PandaDoc document from an existing template.

Templates can contain fields, tokens (variables), pricing tables, images, and content placeholders.
Pre-fill field values, set recipients, and customize content when creating.

WORKFLOW:
1. Call list_templates to find the template ID
2. Create the document with this tool (pre-fill fields/tokens as needed)
3. Poll get_document_status until status is 'document.draft'
4. Use send_document to send for signing

RELATED TOOLS:
- list_templates: Find available templates and their IDs
- get_document_details: See all fields/tokens after creation
- send_document: Send the created document`,
      inputSchema: z.object({
        template_uuid: z.string().min(1).describe('Template ID (from list_templates or PandaDoc app URL)'),
        name: z.string().optional().describe('Document name'),
        recipients: z.array(z.object({
          email: z.string().describe('Recipient email'),
          first_name: z.string().optional().describe('Recipient first name'),
          last_name: z.string().optional().describe('Recipient last name'),
          role: z.string().optional().describe('Must match a role in the template'),
          signing_order: z.number().optional().describe('Order in signing sequence'),
        })).min(1).describe('Document recipients (at least one required)'),
        tokens: z.array(z.object({
          name: z.string().describe('Token/variable name from template'),
          value: z.string().describe('Value to fill in'),
        })).optional().describe('Template variables to pre-fill'),
        fields: z.record(z.unknown()).optional().describe('Map of field names to values: { "FieldName": { "value": "text" } }'),
        metadata: z.record(z.unknown()).optional().describe('Custom key-value metadata to associate with the document'),
        tags: z.array(z.string()).optional().describe('Tags to apply'),
        folder_uuid: z.string().optional().describe('Folder ID to store the document in'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return noApiKeyError();

      const body: Record<string, unknown> = {
        template_uuid: args.template_uuid,
        recipients: args.recipients,
      };
      if (args.name) body.name = args.name;
      if (args.tokens) body.tokens = args.tokens;
      if (args.fields) body.fields = args.fields;
      if (args.metadata) body.metadata = args.metadata;
      if (args.tags) body.tags = args.tags;
      if (args.folder_uuid) body.folder_uuid = args.folder_uuid;

      const result = await pandadocFetch<DocumentCreateResponse>('/documents', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      return JSON.stringify({
        ok: true,
        document: formatDocumentCompact(result as unknown as Record<string, unknown>),
        info: result.info_message || 'Document created. Poll get_document_status until status is "document.draft" before sending.',
      });
    }),
  );

  // ── upload_document ─────────────────────────────────────────────────
  server.registerTool(
    'upload_document',
    {
      description:
        `Upload a PDF, DOCX, or RTF file to PandaDoc to create a new document.

The file is uploaded and converted into an interactive PandaDoc document.
After upload, the document status is 'document.uploaded' and transitions to 'document.draft' after processing (typically 1-5 seconds).

WORKFLOW:
1. Upload the file with this tool
2. Poll get_document_status until status is 'document.draft'
3. Then use send_document to send it for signing

COMMON MISTAKES:
- Don't try to send a document while it's still in 'document.uploaded' status — wait for 'document.draft'
- File must be under 50 MB
- Encrypted PDFs are not supported

RELATED TOOLS:
- get_document_status: Check when document is ready (status = 'document.draft')
- send_document: Send the processed document for e-signature`,
      inputSchema: z.object({
        file_path: z.string().min(1).describe('Absolute path to the PDF, DOCX, or RTF file to upload'),
        name: z.string().optional().describe('Document name in PandaDoc (defaults to filename)'),
        recipients: z.array(z.object({
          email: z.string().describe('Recipient email address'),
          first_name: z.string().optional().describe('Recipient first name'),
          last_name: z.string().optional().describe('Recipient last name'),
          role: z.string().optional().describe('Recipient role (e.g., "Client", "Signer")'),
        })).optional().describe('List of document recipients (at least one required for sending)'),
        parse_form_fields: z.boolean().optional().describe('If true, recognizes PDF form fields as PandaDoc fields. Default: false'),
        tags: z.array(z.string()).optional().describe('Tags to apply to the document'),
        folder_uuid: z.string().optional().describe('ID of the PandaDoc folder to store the document in'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return noApiKeyError();

      const resolvedPath = path.resolve(args.file_path);

      // Validate file exists and check size
      let fileInfo: fs.Stats;
      try {
        fileInfo = fs.statSync(resolvedPath);
      } catch {
        return JSON.stringify({
          ok: false,
          error: `File not found: ${resolvedPath}`,
          resolution: 'Check the file path exists and is accessible.',
        });
      }

      if (fileInfo.size > MAX_FILE_SIZE) {
        return JSON.stringify({
          ok: false,
          error: `File too large (${(fileInfo.size / 1024 / 1024).toFixed(1)}MB). Maximum is 50MB.`,
          resolution: 'Use a smaller file or compress it before uploading.',
        });
      }

      // Validate file extension
      const ext = path.extname(resolvedPath).toLowerCase();
      if (!['.pdf', '.docx', '.rtf'].includes(ext)) {
        return JSON.stringify({
          ok: false,
          error: `Unsupported file type: ${ext}. PandaDoc accepts PDF, DOCX, and RTF files.`,
          resolution: 'Convert the file to PDF, DOCX, or RTF before uploading.',
        });
      }

      const fileBuffer = fs.readFileSync(resolvedPath);
      const fileName = args.name || path.basename(resolvedPath);

      // Build metadata JSON for the 'data' field
      const data: Record<string, unknown> = { name: fileName };
      if (args.recipients) data.recipients = args.recipients;
      if (args.tags) data.tags = args.tags;
      if (args.folder_uuid) data.folder_uuid = args.folder_uuid;
      if (args.parse_form_fields) data.parse_form_fields = true;

      const mimeTypes: Record<string, string> = {
        '.pdf': 'application/pdf',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.rtf': 'application/rtf',
      };

      const formData = new FormData();
      formData.append('file', new Blob([fileBuffer], { type: mimeTypes[ext] || 'application/octet-stream' }), path.basename(resolvedPath));
      formData.append('data', JSON.stringify(data));

      // Upload — use pandadocFetch but with FormData body and no Content-Type (let browser set multipart boundary)
      const key = (await import('../auth.js')).getApiKey();
      const { PANDADOC_API_BASE, REQUEST_TIMEOUT_MS } = await import('../types.js');
      const { PandaDocError } = await import('../types.js');

      const useFormFields = args.parse_form_fields ? '&use_form_field_properties=true' : '';
      const url = `${PANDADOC_API_BASE}/documents?upload${useFormFields}`;

      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: {
            Authorization: `API-Key ${key}`,
          },
          body: formData,
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'TimeoutError') {
          throw new PandaDocError(
            'Upload to PandaDoc API timed out',
            'TIMEOUT',
            'The upload took too long. Try again or use a smaller file.',
          );
        }
        throw error;
      }

      if (!response.ok) {
        if (response.status === 429) {
          throw new PandaDocError(
            'Rate limited by PandaDoc API.',
            'RATE_LIMITED',
            'Wait a moment and try again.',
          );
        }
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new PandaDocError(
          `PandaDoc upload error (${response.status}): ${errorText}`,
          'UPLOAD_ERROR',
          'Check the file and try again.',
        );
      }

      const result = await response.json() as DocumentCreateResponse;

      return JSON.stringify({
        ok: true,
        document: formatDocumentCompact(result as unknown as Record<string, unknown>),
        info: result.info_message || 'Document uploaded. Poll get_document_status until status is "document.draft" before sending.',
      });
    }),
  );

  // ── send_document ───────────────────────────────────────────────────
  server.registerTool(
    'send_document',
    {
      description:
        `Send a PandaDoc document to recipients for viewing/signing.

The document must be in 'document.draft' status before sending.
Optionally include a custom email message and subject line.

COMMON MISTAKES:
- Cannot send a document in 'document.uploaded' status — wait for 'document.draft'
- Cannot re-send a document that is already 'document.completed' or 'document.voided'

RELATED TOOLS:
- get_document_status: Verify document is in 'document.draft' before sending
- get_document_details: Review document content before sending`,
      inputSchema: z.object({
        document_id: z.string().min(1).describe('The document ID'),
        message: z.string().optional().describe('Email body message sent to recipients with the document link'),
        subject: z.string().optional().describe('Email subject line'),
        silent: z.boolean().optional().describe('If true, suppresses email notifications to recipients. Default: false'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return noApiKeyError();

      const body: Record<string, unknown> = {};
      if (args.message) body.message = args.message;
      if (args.subject) body.subject = args.subject;
      if (args.silent !== undefined) body.silent = args.silent;

      const result = await pandadocFetch<DocumentSendResponse>(
        `/documents/${encodeURIComponent(args.document_id)}/send`,
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
      );

      return JSON.stringify({
        ok: true,
        document: {
          id: result.id,
          name: result.name,
          status: result.status,
          recipients: result.recipients,
        },
        message: 'Document sent successfully.',
      });
    }),
  );

  // ── download_document ───────────────────────────────────────────────
  server.registerTool(
    'download_document',
    {
      description:
        `Download a PandaDoc document as a PDF file.

Returns the file path where the PDF has been saved. The document must be in a
completed or sent status to download.

RELATED TOOLS:
- get_document_status: Check document status before downloading
- list_documents: Find document IDs`,
      inputSchema: z.object({
        document_id: z.string().min(1).describe('The document ID'),
        watermark_text: z.string().optional().describe('Optional watermark text to overlay on the PDF'),
        watermark_color: z.string().optional().describe('Watermark color as HEX code (e.g., "#FF5733")'),
        watermark_font_size: z.number().optional().describe('Watermark font size'),
        watermark_opacity: z.number().optional().describe('Watermark opacity (0.0 to 1.0)'),
        separate_files: z.boolean().optional().describe('If true, downloads as a zip archive with separate PDFs per section'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return noApiKeyError();

      const params = new URLSearchParams();
      if (args.watermark_text) params.set('watermark_text', args.watermark_text);
      if (args.watermark_color) params.set('watermark_color', args.watermark_color);
      if (args.watermark_font_size) params.set('watermark_font_size', String(args.watermark_font_size));
      if (args.watermark_opacity) params.set('watermark_opacity', String(args.watermark_opacity));
      if (args.separate_files) params.set('separate_files', 'true');

      const queryStr = params.toString();
      const downloadPath = `/documents/${encodeURIComponent(args.document_id)}/download${queryStr ? `?${queryStr}` : ''}`;

      const response = await pandadocFetchRaw(downloadPath);

      // Save the PDF to a temp file
      const pdfBuffer = Buffer.from(await response.arrayBuffer());
      const tmpDir = process.env.TMPDIR || process.env.TEMP || '/tmp';
      const safeName = `pandadoc_${args.document_id.replace(/[^a-zA-Z0-9_-]/g, '_')}.pdf`;
      const outputPath = path.join(tmpDir, safeName);
      fs.writeFileSync(outputPath, pdfBuffer);

      return JSON.stringify({
        ok: true,
        file_path: outputPath,
        file_size: `${(pdfBuffer.length / 1024).toFixed(1)}KB`,
        message: `Document downloaded to ${outputPath}`,
      });
    }),
  );
}
