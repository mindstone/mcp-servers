import { z } from 'zod';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { pandadocFetch, pandadocFetchRaw } from '../client.js';
import { sanitizeVendorErrorText, withErrorHandling } from '../utils.js';
import { wrapUntrusted } from '../untrusted-content.js';
import { isConfigured } from '../auth.js';
import { MAX_FILE_SIZE, PandaDocError } from '../types.js';
import { readUploadFile } from './path-safety.js';
import { resolvePublicTerminalUrl } from './url-safety.js';
import {
  isSafeIdentifier,
  sanitizeDocumentCompact,
  sanitizeDocumentDetails,
  sanitizeRecipients,
} from '../sanitize.js';
import type {
  DocumentListResponse,
  DocumentCreateResponse,
  DocumentSendResponse,
  DocumentSessionResponse,
} from '../types.js';

function noApiKeyError(): string {
  return JSON.stringify({
    ok: false,
    error: 'PandaDoc API key not configured',
    resolution: 'To use PandaDoc, you need to configure an API key first.',
    next_step: {
      action: 'The user adds the PandaDoc API key in Settings → Connectors in the app. Do not ask for it in chat.',
      get_key_from: 'PandaDoc Settings → API → Developer Dashboard. Requires Business or Enterprise plan.',
    },
  });
}

function formatDocumentCompact(
  doc: Record<string, unknown>,
  source: string,
): Record<string, unknown> {
  return sanitizeDocumentCompact(
    {
      id: doc.id,
      name: doc.name,
      status: doc.status,
      date_created: doc.date_created,
      date_modified: doc.date_modified,
      expiration_date: doc.expiration_date,
      version: doc.version,
    },
    source,
  ) as Record<string, unknown>;
}

function formatDocumentDetails(
  doc: Record<string, unknown>,
  source: string,
): Record<string, unknown> {
  return sanitizeDocumentDetails(
    {
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
    },
    source,
  ) as Record<string, unknown>;
}

function paginationHint(count: number, page: number, pageSize: number): string {
  // The PandaDoc list API returns only `results` — no totals or next-page
  // markers — so a page's length cannot prove completeness. Never claim
  // "all results", and never promise another page exists.
  if (count < pageSize) {
    return `Showing ${count} results (page ${page}). This page is not full, so there are probably no further pages; the API does not report totals.`;
  }
  return `Showing ${count} results (page ${page}). This page is full, so more results may exist — try page=${page + 1}. The API does not report totals.`;
}

/**
 * Semantic request schemas for the open-ended vendor structures. A generic
 * "any JSON value" check only proves serializability; these schemas validate
 * the actual PandaDoc shapes (fail-closed) so a malformed structure is
 * rejected before it reaches the API.
 *
 * - fields: `{ "FieldName": { "value": ... } }` — each entry must be an
 *   object with a scalar `value` (text/date/checkbox pre-fill).
 * - metadata: string-keyed map of scalar values; nested structures rejected.
 * - pricing-table options: `currency` (ISO-4217-style 3-letter code) plus
 *   Tax/Fee/Discount adjustment objects `{ type, value, name? }`.
 * - pricing-table row data: column-name keys with scalar values, or
 *   adjustment objects for Tax/Discount/Fee columns.
 * Shapes per https://developers.pandadoc.com/docs/working-with-pricing-tables
 */
const scalarValue = z.union([z.string(), z.number(), z.boolean()]);

const pricingAdjustment = z
  .object({
    type: z.enum(['percent', 'absolute']),
    name: z.string().optional(),
    value: z.number(),
  })
  .strict();

const documentFieldsSchema = z.record(z.object({ value: scalarValue }).strict());

const documentMetadataSchema = z.record(scalarValue);

const pricingTableOptionsSchema = z
  .object({
    currency: z.string().regex(/^[A-Z]{3}$/, 'currency must be a 3-letter code (e.g., "USD")').optional(),
  })
  .catchall(pricingAdjustment);

const pricingRowDataSchema = z.record(z.union([scalarValue, pricingAdjustment]));

/**
 * `info_message` in a create/upload response is vendor-authored text — wrap it
 * in an untrusted-content envelope before it reaches the model (invariant #6).
 */
function vendorInfoMessage(value: string | undefined, source: string, fallback: string): string {
  if (!value) return fallback;
  return wrapUntrusted(value, source) ?? fallback;
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

      const documents = (result.results || []).map((d) =>
        formatDocumentCompact(d, 'pandadoc:list_documents'),
      );
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

      return JSON.stringify({
        ok: true,
        document: formatDocumentCompact(result, 'pandadoc:get_document_status'),
      });
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

      return JSON.stringify({
        ok: true,
        document: formatDocumentDetails(result, 'pandadoc:get_document_details'),
      });
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
          email: z.string().email().describe('Recipient email'),
          first_name: z.string().optional().describe('Recipient first name'),
          last_name: z.string().optional().describe('Recipient last name'),
          role: z.string().optional().describe('Must match a role in the template'),
          signing_order: z.number().optional().describe('Order in signing sequence'),
        })).min(1).describe('Document recipients (at least one required)'),
        tokens: z.array(z.object({
          name: z.string().describe('Token/variable name from template'),
          value: z.string().describe('Value to fill in'),
        })).optional().describe('Template variables to pre-fill'),
        fields: documentFieldsSchema.optional().describe('Map of field names to values: { "FieldName": { "value": "text" } }'),
        pricing_tables: z.array(z.object({
          name: z.string().describe('Name of the pricing table in the template to populate'),
          data_merge: z.boolean().optional().describe('If true, all field names in data rows must be the external names defined in the template'),
          options: pricingTableOptionsSchema.optional().describe('Table options, e.g. { "currency": "USD", "Discount": { "type": "percent", "name": "Global Discount", "value": 10 } }'),
          sections: z.array(z.object({
            title: z.string().describe('Section title'),
            default: z.boolean().optional().describe('If true, this is the default section'),
            multichoice_enabled: z.boolean().optional().describe('If true, recipients can pick rows in this section'),
            rows: z.array(z.object({
              options: z.object({
                qty_editable: z.boolean().optional(),
                optional_selected: z.boolean().optional(),
                optional: z.boolean().optional(),
                multichoice_selected: z.boolean().optional(),
              }).optional().describe('Row options (editable qty, optional row, pre-selected)'),
              data: pricingRowDataSchema.optional().describe('Row values keyed by column name, e.g. { "Name": "Widget", "Price": 10, "QTY": 3, "SKU": "widget-1" }'),
              custom_fields: z.record(scalarValue).optional().describe('Additional custom column values'),
            })).optional().describe('Rows to populate in this section'),
          })).optional().describe('Pricing table sections with rows'),
        })).optional().describe('Pricing tables to populate. Requires "Automatically add products to this table" enabled on the template pricing table. All product info must be passed here — products stored in PandaDoc cannot be used.'),
        metadata: documentMetadataSchema.optional().describe('Custom key-value metadata to associate with the document'),
        tags: z.array(z.string()).optional().describe('Tags to apply'),
        folder_uuid: z.string().optional().describe('Folder ID to store the document in (see list_document_folders)'),
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
      if (args.pricing_tables) body.pricing_tables = args.pricing_tables;
      if (args.metadata) body.metadata = args.metadata;
      if (args.tags) body.tags = args.tags;
      if (args.folder_uuid) body.folder_uuid = args.folder_uuid;

      const result = await pandadocFetch<DocumentCreateResponse>('/documents', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      return JSON.stringify({
        ok: true,
        document: formatDocumentCompact(
          result as unknown as Record<string, unknown>,
          'pandadoc:create_document_from_template',
        ),
        info: vendorInfoMessage(
          result.info_message,
          'pandadoc:create_document_from_template:info_message',
          'Document created. Poll get_document_status until status is "document.draft" before sending.',
        ),
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
          email: z.string().email().describe('Recipient email address'),
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

      // ----------------------------------------------------------------
      // SECURITY (M3.7): sandbox local file reads to under
      // `MCP_WORKSPACE_PATH` (or `os.tmpdir()` if unset). LLM-controlled
      // input cannot be allowed to point at arbitrary host files such as
      // `~/.ssh/id_rsa` or `/etc/passwd`, where the bytes would otherwise
      // be uploaded to the PandaDoc API as a "document".
      //
      // `readUploadFile` validates the path AND reads it as one
      // race-resistant operation: canonical containment, a single
      // O_NOFOLLOW open, fstat-based type/size checks, an ancestor-swap
      // re-resolution bound to the opened inode, and a descriptor-bounded
      // read. See src/tools/path-safety.ts.
      // ----------------------------------------------------------------
      const readResult = await readUploadFile(args.file_path, MAX_FILE_SIZE);
      if (!readResult.ok) {
        const resolutions: Record<string, string> = {
          'outside-workspace':
            'Place the file under MCP_WORKSPACE_PATH (or os.tmpdir() when ' +
            'the env var is unset) before uploading.',
          'not-found': 'Check the file path exists and is accessible.',
          'not-regular-file': 'Pass the path of a PDF, DOCX, or RTF file, not a directory or device.',
          'too-large': 'Use a smaller file or compress it before uploading.',
          changed: 'Try the upload again.',
        };
        return JSON.stringify({
          ok: false,
          error: readResult.error,
          resolution: resolutions[readResult.kind],
        });
      }
      const resolvedPath = readResult.path;

      // Validate file extension (lexical — no disk access).
      const ext = path.extname(resolvedPath).toLowerCase();
      if (!['.pdf', '.docx', '.rtf'].includes(ext)) {
        return JSON.stringify({
          ok: false,
          error: `Unsupported file type: ${ext}. PandaDoc accepts PDF, DOCX, and RTF files.`,
          resolution: 'Convert the file to PDF, DOCX, or RTF before uploading.',
        });
      }

      const fileBuffer = readResult.buffer;
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
      formData.append('file', new Blob([new Uint8Array(fileBuffer)], { type: mimeTypes[ext] || 'application/octet-stream' }), path.basename(resolvedPath));
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
        const errorText = await response.text().catch(() => '');
        throw new PandaDocError(
          `PandaDoc upload error (${response.status}): ${
            errorText
              ? sanitizeVendorErrorText(errorText, 'pandadoc:upload_document:error_body')
              : 'no error details provided'
          }`,
          'UPLOAD_ERROR',
          'Check the file and try again.',
        );
      }

      // Mirror pandadocFetch's fail-closed JSON handling: a JSON.parse
      // failure message is runtime-generated and can echo body fragments —
      // never surface it (or the body) to the model.
      const responseText = await response.text();
      let result: DocumentCreateResponse;
      try {
        result = (responseText ? JSON.parse(responseText) : {}) as DocumentCreateResponse;
      } catch {
        throw new PandaDocError(
          `PandaDoc API returned a malformed (non-JSON) response (status ${response.status}).`,
          'INVALID_RESPONSE',
          'Try the upload again. If it persists, the PandaDoc API may be degraded.',
        );
      }

      return JSON.stringify({
        ok: true,
        document: formatDocumentCompact(
          result as unknown as Record<string, unknown>,
          'pandadoc:upload_document',
        ),
        info: vendorInfoMessage(
          result.info_message,
          'pandadoc:upload_document:info_message',
          'Document uploaded. Poll get_document_status until status is "document.draft" before sending.',
        ),
      });
    }),
  );

  // ── create_document_from_url ────────────────────────────────────────
  server.registerTool(
    'create_document_from_url',
    {
      description:
        `Create a PandaDoc document from a publicly accessible PDF URL.

PandaDoc fetches the PDF server-side, so no local file is needed — use this
instead of upload_document when the source file is already hosted online.

WORKFLOW:
1. Create the document with this tool
2. Poll get_document_status until status is 'document.draft'
3. Then use send_document to send it for signing

COMMON MISTAKES:
- The URL must be HTTPS and publicly accessible (no auth headers, no expiring signed URLs that PandaDoc cannot reach)
- Don't try to send while status is 'document.uploaded' — wait for 'document.draft'

RELATED TOOLS:
- upload_document: Upload a local file instead (must live under MCP_WORKSPACE_PATH)
- get_document_status: Check when the document is ready (status = 'document.draft')
- send_document: Send the processed document for e-signature`,
      inputSchema: z.object({
        url: z
          .string()
          .url()
          .refine((u) => u.startsWith('https://'), { message: 'url must be HTTPS' })
          .describe('Secure (HTTPS) and publicly accessible URL to the PDF document'),
        name: z.string().min(1).describe('Document name in PandaDoc'),
        recipients: z.array(z.object({
          email: z.string().email().describe('Recipient email address'),
          first_name: z.string().optional().describe('Recipient first name'),
          last_name: z.string().optional().describe('Recipient last name'),
          role: z.string().optional().describe('Recipient role (e.g., "Client", "Signer")'),
        })).optional().describe('List of document recipients (at least one required for sending)'),
        parse_form_fields: z.boolean().optional().describe('If true, recognizes PDF form fields as PandaDoc fields. Default: false'),
        fields: documentFieldsSchema.optional().describe('Map of field names to values: { "FieldName": { "value": "text" } }'),
        tokens: z.array(z.object({
          name: z.string().describe('Token/variable name'),
          value: z.string().describe('Value to fill in'),
        })).optional().describe('Tokens (variables) to pre-fill'),
        metadata: documentMetadataSchema.optional().describe('Custom key-value metadata to associate with the document'),
        tags: z.array(z.string()).optional().describe('Tags to apply to the document'),
        folder_uuid: z.string().optional().describe('ID of the PandaDoc folder to store the document in (see list_document_folders)'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return noApiKeyError();

      // The URL is fetched server-side by PandaDoc, which makes this tool an
      // indirect fetch primitive. The connector enforces what it can: refuse
      // literal internal hosts and credential-bearing URLs, DNS-resolve the
      // host and refuse non-public answers, and follow the redirect chain
      // under the same policy — PandaDoc receives ONLY the terminal URL.
      // (DNS-rebinding TOCTOU between our lookup and PandaDoc's fetch is
      // inherently vendor-side; see src/tools/url-safety.ts.)
      const urlCheck = await resolvePublicTerminalUrl(args.url);
      if (!urlCheck.ok) {
        return JSON.stringify({
          ok: false,
          // The rejection reason can embed an attacker-chosen redirect URL
          // or host — envelope it before it reaches the model (invariant #6).
          error: `Rejected source URL: ${
            wrapUntrusted(urlCheck.error, 'pandadoc:create_document_from_url:rejected_url') ??
            urlCheck.error
          }.`,
          resolution: 'Provide an HTTPS URL on a public host that PandaDoc can reach.',
        });
      }

      const body: Record<string, unknown> = {
        url: urlCheck.url,
        name: args.name,
      };
      if (args.recipients) body.recipients = args.recipients;
      if (args.parse_form_fields !== undefined) body.parse_form_fields = args.parse_form_fields;
      if (args.fields) body.fields = args.fields;
      if (args.tokens) body.tokens = args.tokens;
      if (args.metadata) body.metadata = args.metadata;
      if (args.tags) body.tags = args.tags;
      if (args.folder_uuid) body.folder_uuid = args.folder_uuid;

      const result = await pandadocFetch<DocumentCreateResponse>('/documents', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      return JSON.stringify({
        ok: true,
        document: formatDocumentCompact(
          result as unknown as Record<string, unknown>,
          'pandadoc:create_document_from_url',
        ),
        info: vendorInfoMessage(
          result.info_message,
          'pandadoc:create_document_from_url:info_message',
          'Document created. Poll get_document_status until status is "document.draft" before sending.',
        ),
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

⚠️ WARNING — silent: true SUPPRESSES SIGNER NOTIFICATIONS.
Setting silent: true tells PandaDoc to skip / suppress the email notifications
that would normally be sent to every recipient. The document is still marked
as sent on the PandaDoc side, but no signer notification email is delivered,
which means recipients have no way of knowing the document is waiting for
them unless they are notified through some other channel. Default is false
(notifications are sent). Only pass silent: true when the user has explicitly
asked you to skip / suppress the email notifications for this send.

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
          ...(sanitizeDocumentCompact(
            {
              id: result.id,
              name: result.name,
              status: result.status,
            },
            'pandadoc:send_document',
          ) as Record<string, unknown>),
          recipients: sanitizeRecipients(result.recipients, 'pandadoc:send_document:recipients'),
        },
        message: 'Document sent successfully.',
      });
    }),
  );

  // ── create_document_session ─────────────────────────────────────────
  server.registerTool(
    'create_document_session',
    {
      description:
        `Create a view/sign session link for a PandaDoc document recipient.

Returns a shareable URL (https://app.pandadoc.com/s/{session_id}) the named
recipient can open to view and sign the document — the standard way to hand a
client a signing link directly instead of relying on PandaDoc's email.

⚠️ WARNING — anyone with the link can view and sign as that recipient until
the session expires. Only create a session when the user has explicitly asked
for a signing/view link, and share the URL only through a channel the user
chose. The document must already be in 'document.sent' status.

RELATED TOOLS:
- send_document: Send the document first (session creation requires 'document.sent')
- get_document_status: Check the document's current status`,
      inputSchema: z.object({
        document_id: z.string().min(1).describe('The document ID'),
        recipient: z
          .string()
          .email()
          .describe('Email address of the document recipient the session is created for'),
        lifetime: z
          .number()
          .int()
          .min(60)
          .max(31535999)
          .optional()
          .describe('Link lifetime in seconds (60 to 31535999 ≈ 1 year). Default: 3600 (1 hour)'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return noApiKeyError();

      const body: Record<string, unknown> = { recipient: args.recipient };
      if (args.lifetime !== undefined) body.lifetime = args.lifetime;

      const result = await pandadocFetch<DocumentSessionResponse>(
        `/documents/${encodeURIComponent(args.document_id)}/session`,
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
      );

      // The session id is interpolated into the signing URL below, so it
      // must actually BE an identifier: anything else (instruction-bearing
      // text from a hostile or compromised response) would produce a
      // URL-shaped string carrying attacker prose. There is no enveloped
      // form of a usable link — fail closed instead.
      if (typeof result.id !== 'string' || !isSafeIdentifier(result.id)) {
        throw new PandaDocError(
          'PandaDoc API returned a malformed session response (unexpected session id).',
          'INVALID_RESPONSE',
          'Try the request again. If it persists, the PandaDoc API may be degraded.',
        );
      }

      return JSON.stringify({
        ok: true,
        session: {
          id: result.id,
          expires_at: result.expires_at,
          url: `https://app.pandadoc.com/s/${result.id}`,
        },
        message: `Signing session created for ${args.recipient}. Share the url with the recipient only — anyone with it can view and sign until it expires.`,
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
        watermark_color: z
          .string()
          .regex(/^#[0-9A-Fa-f]{6}$/, 'watermark_color must be a 6-digit HEX code (e.g., "#FF5733")')
          .optional()
          .describe('Watermark color as HEX code (e.g., "#FF5733")'),
        watermark_font_size: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe('Watermark font size (integer, 1-500)'),
        watermark_opacity: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe('Watermark opacity (0.0 to 1.0)'),
        separate_files: z.boolean().optional().describe('If true, downloads as a zip archive with separate PDFs per section'),
      }),
      // Not read-only: the tool writes a new local temp file. It is still
      // non-destructive — downloads use exclusive create and never overwrite.
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
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

      // Save the PDF under the canonical OS temp directory. The raw
      // TMPDIR/TEMP env strings are NOT trusted verbatim: a process that can
      // mutate the environment could point them at an arbitrary (possibly
      // symlinked) location; os.tmpdir() + realpathSync gives the canonical
      // containment anchor instead.
      const pdfBuffer = Buffer.from(await response.arrayBuffer());
      const tmpRoot = fs.realpathSync(os.tmpdir());

      // Unique name + exclusive create: downloads never overwrite an
      // existing file, and a pre-positioned file or symlink can neither be
      // clobbered nor redirect the write (O_EXCL fails on any existing
      // entry, including symlinks).
      // Bound the id-derived portion: an over-long document_id would
      // otherwise surface a raw ENAMETOOLONG from the open below through
      // the generic error path. The random suffix keeps names unique.
      const safeBase = `pandadoc_${args.document_id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100)}`;
      let outputPath: string | undefined;
      for (let attempt = 0; attempt < 3 && !outputPath; attempt += 1) {
        const candidate = path.join(
          tmpRoot,
          `${safeBase}_${crypto.randomBytes(6).toString('hex')}.pdf`,
        );
        // Canonical-prefix containment, kept explicit so a future refactor
        // cannot silently weaken the boundary.
        const relative = path.relative(tmpRoot, candidate);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          throw new PandaDocError(
            'Resolved download path escaped the temp directory.',
            'DOWNLOAD_ERROR',
            'Try the download again.',
          );
        }
        let outFd: number;
        try {
          outFd = fs.openSync(candidate, 'wx');
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
          throw err;
        }
        try {
          fs.writeFileSync(outFd, pdfBuffer);
        } finally {
          fs.closeSync(outFd);
        }
        outputPath = candidate;
      }
      if (!outputPath) {
        throw new PandaDocError(
          'Could not allocate a temp file for the download.',
          'DOWNLOAD_ERROR',
          'Try the download again.',
        );
      }

      return JSON.stringify({
        ok: true,
        file_path: outputPath,
        file_size: `${(pdfBuffer.length / 1024).toFixed(1)}KB`,
        message: `Document downloaded to ${outputPath}`,
      });
    }),
  );
}
