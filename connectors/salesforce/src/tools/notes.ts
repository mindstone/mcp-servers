import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorHandling, escapeSOQL, sanitizeRecords, checkSaveResult } from '../utils.js';
import { withConnection } from '../client.js';
import { ConnectorError, type SaveResult } from '../types.js';

export function registerNoteTools(server: McpServer): void {
  server.registerTool(
    'salesforce_get_notes',
    {
      description: `Get notes attached to a record (ContentNote linked via ContentDocumentLink). Required: parent_id (Account, Contact, Opportunity, Case, Lead, or any record ID). Returns note Id, Title, TextPreview, CreatedDate, OwnerId; set include_body=true to also return the full note text. Max 200 (default: 50).`,
      inputSchema: z.object({
        parent_id: z.string().min(1).describe('Record ID the notes are attached to (required)'),
        include_body: z.boolean().optional().describe('Include full note body text (default: false — returns title and preview only)'),
        limit: z.number().int().min(1).max(200).optional().describe('Max results 1-200 (default: 50)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      return withConnection(undefined, async (conn) => {
        const fields = ['Id', 'Title', 'TextPreview', 'CreatedDate', 'LastModifiedDate', 'OwnerId'];
        if (args.include_body) fields.push('Content');
        const limit = Math.min(Math.max(1, args.limit ?? 50), 200);
        const query =
          `SELECT ${fields.join(', ')} FROM ContentNote` +
          ` WHERE Id IN (SELECT ContentDocumentId FROM ContentDocumentLink WHERE LinkedEntityId = '${escapeSOQL(args.parent_id)}')` +
          ` ORDER BY CreatedDate DESC LIMIT ${limit}`;
        const result = await conn.query(query);
        // ContentNote.Content is base64-encoded UTF-8; decode it for the model.
        // The raw base64 is never returned — decode it when requested, drop it
        // otherwise.
        const records = (result.records as Record<string, unknown>[]).map((record) => {
          const { Content, ...rest } = record;
          if (args.include_body && typeof Content === 'string') {
            let body: string;
            try {
              body = Buffer.from(Content, 'base64').toString('utf8');
            } catch {
              body = Content;
            }
            return { ...rest, body };
          }
          return rest;
        });
        return JSON.stringify({ ok: true, records: sanitizeRecords(records, 'salesforce:get_notes:records'), totalSize: result.totalSize });
      });
    }),
  );

  server.registerTool(
    'salesforce_create_note',
    {
      description: `Create a note (ContentNote). Required: title, body. Optional: parent_id — a record ID to attach the note to (Account, Contact, Opportunity, Case, Lead, etc.).`,
      inputSchema: z.object({
        title: z.string().min(1).describe('Note title (required)'),
        body: z.string().min(1).describe('Note body text (required)'),
        parent_id: z.string().optional().describe('Record ID to attach the note to'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      return withConnection(undefined, async (conn) => {
        const noteResult = await conn.sobject('ContentNote').create({
          Title: args.title,
          Content: Buffer.from(args.body, 'utf8').toString('base64'),
        });
        if (!noteResult.success) throw new ConnectorError('Failed to create note', 'CREATE_ERROR', JSON.stringify(noteResult.errors));

        let linkedTo: string | undefined;
        if (args.parent_id) {
          const linkResult = await conn.sobject('ContentDocumentLink').create({
            ContentDocumentId: noteResult.id,
            LinkedEntityId: args.parent_id,
            ShareType: 'V',
          }) as unknown as SaveResult;
          checkSaveResult(linkResult, 'Note created but failed to attach it to the parent record');
          linkedTo = args.parent_id;
        }

        return JSON.stringify({ ok: true, status: 'success', object: 'ContentNote', id: noteResult.id, title: args.title, ...(linkedTo ? { linked_to: linkedTo } : {}) });
      });
    }),
  );
}
