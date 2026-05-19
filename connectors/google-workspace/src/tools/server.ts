import { createRequire } from 'node:module';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import logger from '../utils/logger.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  McpError,
  Tool
} from "@modelcontextprotocol/sdk/types.js";

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string };
export const SERVER_VERSION = pkg.version;
export const SERVER_INFO = { name: 'Google Workspace MCP Server', version: SERVER_VERSION };

// Import tool definitions and registry
import { allTools } from './definitions.js';
import { ToolRegistry } from '../modules/tools/registry.js';

// Import handlers
import {
  handleListWorkspaceAccounts,
  handleAuthenticateWorkspaceAccount,
  handleRemoveWorkspaceAccount
} from './account-handlers.js';

import {
  handleSearchWorkspaceEmails,
  handleGetWorkspaceEmailThread,
  handleComposeWorkspaceEmail,
  handleSendWorkspaceEmail,
  handleGetWorkspaceGmailSettings,
  handleManageWorkspaceDraft,
  handleManageWorkspaceLabel,
  handleManageWorkspaceLabelAssignment,
  handleManageWorkspaceLabelFilter,
  handleManageWorkspaceAttachment,
  handleListWorkspaceDrafts,
  handleGetWorkspaceDraft,
  handleCreateWorkspaceDraft,
  handleUpdateWorkspaceDraft,
  handleDeleteWorkspaceDraft,
  handleSendWorkspaceDraft,
  handleDownloadWorkspaceAttachment,
  handleUploadWorkspaceAttachment,
  handleDeleteWorkspaceAttachment,
  handleListWorkspaceLabels,
  handleGetWorkspaceLabel,
  handleCreateWorkspaceLabel,
  handleUpdateWorkspaceLabel,
  handleDeleteWorkspaceLabel,
  handleListWorkspaceLabelFilters,
  handleCreateWorkspaceLabelFilter,
  handleUpdateWorkspaceLabelFilter,
  handleDeleteWorkspaceLabelFilter,
  handleArchiveWorkspaceEmail,
  handleTrashWorkspaceEmail,
  handleUntrashWorkspaceEmail,
  handleMarkWorkspaceEmailRead,
  handleMarkWorkspaceEmailUnread
} from './gmail-handlers.js';

import {
  handleGetCurrentTime,
  handleFindFreeSlots,
  handleListWorkspaceCalendars,
  handleListWorkspaceCalendarEvents,
  handleGetWorkspaceCalendarEvent,
  handleManageWorkspaceCalendarEvent,
  handleCreateWorkspaceCalendarEvent,
  handleDeleteWorkspaceCalendarEvent
} from './calendar-handlers.js';

import {
  handleListDriveFiles,
  handleSearchDriveFiles,
  handleUploadDriveFile,
  handleDownloadDriveFile,
  handleCreateDriveFolder,
  handleUpdateDrivePermissions,
  handleDeleteDriveFile,
  handleCopyDriveFile,
  handleMoveDriveFile,
  handleTrashDriveFile,
  handleUntrashDriveFile,
  handleListFileRevisions,
  handleDownloadFileRevision
} from './drive-handlers.js';

// Import contact handlers
import { handleGetContacts, handleSearchContacts } from './contacts-handlers.js';

// Import docs handlers
import {
  handleReadDocument,
  handleCreateDocument,
  handleAppendDocument,
  handleReplaceDocument,
  handleFindAndReplace,
  handleExtractDocumentId,
  handleListDocumentTabs,
  handleBatchUpdateDocument
} from './docs-handlers.js';

// Import comments handlers
import {
  handleListComments,
  handleCreateComment,
  handleResolveComment,
  handleReplyToComment,
  handleDeleteComment
} from './comments-handlers.js';

// Import slides handlers
import {
  handleReadPresentation,
  handleCreatePresentation,
  handleListSlides,
  handleGetSlide,
  handleExtractPresentationId,
  handleBatchUpdatePresentation,
  handleGetSlideThumbnail
} from './slides-handlers.js';

// Import sheets handlers
import {
  handleReadSpreadsheet,
  handleReadSpreadsheetValues,
  handleCreateSpreadsheet,
  handleAppendValues,
  handleUpdateValues,
  handleClearValues,
  handleListSheets,
  handleAddSheet,
  handleDeleteSheet,
  handleExtractSpreadsheetId,
  handleBatchGetValues,
  handleBatchUpdateValues,
  handleFindReplace,
  handleFormatCells
} from './sheets-handlers.js';

// Import tasks handlers
import {
  handleListTaskLists,
  handleListTasks,
  handleCreateTask,
  handleUpdateTask,
  handleCompleteTask,
  handleDeleteTask
} from './tasks-handlers.js';

// Import forms handlers
import {
  handleListForms,
  handleGetForm,
  handleListFormResponses,
  handleGetFormResponse
} from './forms-handlers.js';

// Import error types
import { AccountError } from '../modules/accounts/types.js';
import { GmailError } from '../modules/gmail/types.js';
import { CalendarError } from '../modules/calendar/types.js';
import { ContactsError } from '../modules/contacts/types.js';

// Import service initializer
import { initializeAllServices } from '../utils/service-initializer.js';

// Import types and type guards
import {
  CalendarEventParams,
  ListCalendarsArgs,
  SendEmailArgs,
  AuthenticateAccountArgs,
  ManageDraftParams,
  ManageAttachmentParams,
  McpToolResponse,
} from './types.js';
import {
  ManageLabelParams,
  ManageLabelAssignmentParams,
  ManageLabelFilterParams
} from '../modules/gmail/services/label.js';

import {
  assertBaseToolArguments,
  assertListCalendarsArgs,
  assertCalendarEventParams,
  assertEmailEventIdArgs,
  assertSendEmailArgs,
  assertManageDraftParams,
  assertManageLabelParams,
  assertManageLabelAssignmentParams,
  assertManageLabelFilterParams,
  assertDriveFileListArgs,
  assertDriveSearchArgs,
  assertDriveUploadArgs,
  assertDriveDownloadArgs,
  assertDriveFolderArgs,
  assertDrivePermissionArgs,
  assertDriveDeleteArgs,
  assertDriveCopyArgs,
  assertDriveMoveArgs,
  assertDriveTrashArgs,
  assertDriveRevisionsArgs,
  assertDriveDownloadRevisionArgs,
  assertManageAttachmentParams,
  assertGetContactsParams,
  assertReadDocumentArgs,
  assertCreateDocumentArgs,
  assertAppendDocumentArgs,
  assertReplaceDocumentArgs,
  assertFindReplaceArgs,
  assertExtractIdArgs,
  assertListTabsArgs,
  assertBatchUpdateDocumentArgs,
  assertReadPresentationArgs,
  assertCreatePresentationArgs,
  assertListSlidesArgs,
  assertGetSlideArgs,
  assertExtractPresentationIdArgs,
  assertReadSpreadsheetArgs,
  assertReadSpreadsheetValuesArgs,
  assertCreateSpreadsheetArgs,
  assertAppendSpreadsheetArgs,
  assertUpdateSpreadsheetValuesArgs,
  assertClearSpreadsheetValuesArgs,
  assertListSpreadsheetSheetsArgs,
  assertAddSpreadsheetSheetArgs,
  assertDeleteSpreadsheetSheetArgs,
  assertExtractSpreadsheetIdArgs,
  assertBatchGetSpreadsheetValuesArgs,
  assertBatchUpdateSpreadsheetValuesArgs,
  assertFindReplaceSpreadsheetArgs,
  assertFormatSpreadsheetCellsArgs,
  assertBatchUpdatePresentationArgs,
  assertGetSlideThumbnailArgs,
  assertListTaskListsArgs,
  assertListTasksArgs,
  assertCreateTaskArgs,
  assertUpdateTaskArgs,
  assertCompleteTaskArgs,
  assertDeleteTaskArgs,
  assertListFormsArgs,
  assertGetFormArgs,
  assertListFormResponsesArgs,
  assertGetFormResponseArgs,
  assertListCommentsArgs,
  assertCreateCommentArgs,
  assertResolveCommentArgs,
  assertReplyToCommentArgs,
  assertDeleteCommentArgs,
  assertGmailQuickActionArgs
} from './type-guards.js';
import { COMPOSE_EMAIL_HTML } from '../resources/compose-email-template.js';
import { normalizeArgs } from './param-normalizer.js';

interface InlineUiToolResult {
  text: string;
  structuredContent?: unknown;
  _meta?: Record<string, unknown>;
}

function isInlineUiToolResult(result: unknown): result is InlineUiToolResult {
  if (typeof result !== 'object' || result === null) return false;
  const candidate = result as Record<string, unknown>;
  if (typeof candidate.text !== 'string') return false;
  if (typeof candidate._meta !== 'object' || candidate._meta === null) return false;
  const ui = (candidate._meta as Record<string, unknown>).ui;
  if (typeof ui !== 'object' || ui === null) return false;
  return typeof (ui as Record<string, unknown>).resourceUri === 'string';
}

function isMcpToolResponseResult(result: unknown): result is McpToolResponse {
  if (typeof result !== 'object' || result === null) return false;
  const candidate = result as Record<string, unknown>;
  if (!Array.isArray(candidate.content)) return false;
  const contentValid = candidate.content.every((entry) => {
    if (typeof entry !== 'object' || entry === null) return false;
    const block = entry as Record<string, unknown>;
    return block.type === 'text' && typeof block.text === 'string';
  });
  if (!contentValid) return false;
  if (candidate.isError !== undefined && typeof candidate.isError !== 'boolean') return false;
  return true;
}

function extractResultMeta(result: unknown): Record<string, unknown> {
  if (typeof result !== 'object' || result === null) {
    return {};
  }
  const maybeMeta = (result as { _meta?: unknown })._meta;
  return (typeof maybeMeta === 'object' && maybeMeta !== null)
    ? (maybeMeta as Record<string, unknown>)
    : {};
}

export class GSuiteServer {
  private server: Server;
  private toolRegistry: ToolRegistry;

  constructor() {
    this.toolRegistry = new ToolRegistry(allTools);
    this.server = new Server(
      {
        name: "Google Workspace MCP Server",
        version: SERVER_VERSION
      },
      {
        capabilities: {
          tools: {
            list: true,
            call: true
          },
          resources: {}
        }
      }
    );

    this.setupRequestHandlers();
  }

  private setupRequestHandlers(): void {
    // Tools are registered through the ToolRegistry which serves as a single source of truth
    // for both tool discovery (ListToolsRequestSchema) and execution (CallToolRequestSchema).
    // Tools only need to be defined once in allTools and the registry handles making them
    // available to both handlers.
    
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      // Get tools with categories organized
      const categories = this.toolRegistry.getCategories();
      const toolsByCategory: { [key: string]: Tool[] } = {};
      
      for (const category of categories) {
        // Convert ToolMetadata to Tool (strip out category and aliases for SDK compatibility)
        toolsByCategory[category.name] = category.tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations
        }));
      }

      return {
        tools: allTools.map(tool => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations
        })),
        _meta: {
          categories: toolsByCategory,
          aliases: Object.fromEntries(
            allTools.flatMap(tool => 
              (tool.aliases || []).map(alias => [alias, tool.name])
            )
          )
        }
      };
    });

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      if (request.params.uri === 'ui://google-workspace/compose-email') {
        return {
          contents: [{
            uri: request.params.uri,
            mimeType: 'text/html',
            text: COMPOSE_EMAIL_HTML
          }]
        };
      }

      throw new McpError(
        ErrorCode.InvalidRequest,
        `Unknown resource: ${request.params.uri}`
      );
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      try {
        const rawArgs = request.params.arguments;
        const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
          ? normalizeArgs(rawArgs as Record<string, unknown>)
          : {};
        const toolName = request.params.name;
        
        // Look up the tool using the registry
        const tool = this.toolRegistry.getTool(toolName);
        if (!tool) {
          // Generate helpful error message with suggestions
          const errorMessage = this.toolRegistry.formatErrorWithSuggestions(toolName);
          throw new Error(errorMessage);
        }
        
        let result;
        // Use the canonical tool name for the switch
        switch (tool.name) {
          // Account Management
          case 'list_workspace_accounts':
            result = await handleListWorkspaceAccounts();
            break;
          case 'authenticate_workspace_account':
            result = await handleAuthenticateWorkspaceAccount(args as AuthenticateAccountArgs);
            break;
          case 'remove_workspace_account':
            assertBaseToolArguments(args);
            result = await handleRemoveWorkspaceAccount(args);
            break;

          // Gmail Operations
          case 'search_workspace_emails':
            assertBaseToolArguments(args);
            result = await handleSearchWorkspaceEmails(args);
            break;
          case 'get_workspace_email_thread':
            assertBaseToolArguments(args);
            result = await handleGetWorkspaceEmailThread(args as { email: string; threadId: string; maxMessages?: number; offset?: number; includeBody?: boolean });
            break;
          case 'compose_workspace_email':
            assertSendEmailArgs(args);
            result = await handleComposeWorkspaceEmail(args as SendEmailArgs);
            break;
          case 'send_workspace_email':
            assertSendEmailArgs(args);
            result = await handleSendWorkspaceEmail(args as SendEmailArgs);
            break;
          case 'get_workspace_gmail_settings':
            assertBaseToolArguments(args);
            result = await handleGetWorkspaceGmailSettings(args);
            break;

          // Gmail Quick Actions
          case 'archive_workspace_email':
            assertGmailQuickActionArgs(args);
            result = await handleArchiveWorkspaceEmail(args);
            break;
          case 'trash_workspace_email':
            assertGmailQuickActionArgs(args);
            result = await handleTrashWorkspaceEmail(args);
            break;
          case 'untrash_workspace_email':
            assertGmailQuickActionArgs(args);
            result = await handleUntrashWorkspaceEmail(args);
            break;
          case 'mark_workspace_email_read':
            assertGmailQuickActionArgs(args);
            result = await handleMarkWorkspaceEmailRead(args);
            break;
          case 'mark_workspace_email_unread':
            assertGmailQuickActionArgs(args);
            result = await handleMarkWorkspaceEmailUnread(args);
            break;

          // Individual Draft Operations
          case 'list_workspace_drafts':
            assertBaseToolArguments(args);
            result = await handleListWorkspaceDrafts(args);
            break;
          case 'get_workspace_draft':
            assertBaseToolArguments(args);
            result = await handleGetWorkspaceDraft(args as { email?: string; draftId: string });
            break;
          case 'create_workspace_draft':
            assertBaseToolArguments(args);
            result = await handleCreateWorkspaceDraft(args);
            break;
          case 'update_workspace_draft':
            assertBaseToolArguments(args);
            result = await handleUpdateWorkspaceDraft(args);
            break;
          case 'delete_workspace_draft':
            assertBaseToolArguments(args);
            result = await handleDeleteWorkspaceDraft(args as { email?: string; draftId: string });
            break;
          case 'send_workspace_draft':
            assertBaseToolArguments(args);
            result = await handleSendWorkspaceDraft(args as { email?: string; draftId: string });
            break;

          // Draft Management (deprecated)
          case 'manage_workspace_draft':
            assertManageDraftParams(args);
            result = await handleManageWorkspaceDraft(args as ManageDraftParams);
            break;

          // Individual Attachment Operations
          case 'download_workspace_attachment':
            assertBaseToolArguments(args);
            result = await handleDownloadWorkspaceAttachment(args as { email?: string; source: 'email' | 'calendar'; messageId: string; filename: string });
            break;
          case 'upload_workspace_attachment':
            assertBaseToolArguments(args);
            result = await handleUploadWorkspaceAttachment(args as { email?: string; source: 'email' | 'calendar'; messageId: string; filename: string; mimeType?: string; content: string });
            break;
          case 'delete_workspace_attachment':
            assertBaseToolArguments(args);
            result = await handleDeleteWorkspaceAttachment(args as { email?: string; source: 'email' | 'calendar'; messageId: string; filename: string });
            break;

          // Attachment Management (deprecated)
          case 'manage_workspace_attachment':
            assertManageAttachmentParams(args);
            result = await handleManageWorkspaceAttachment(args as ManageAttachmentParams);
            break;

          // Calendar Operations
          case 'get_current_time':
            assertBaseToolArguments(args);
            result = await handleGetCurrentTime(args);
            break;
          case 'find_free_slots':
            assertBaseToolArguments(args);
            result = await handleFindFreeSlots(args);
            break;
          case 'list_workspace_calendars':
            assertListCalendarsArgs(args);
            result = await handleListWorkspaceCalendars(args as ListCalendarsArgs);
            break;
          case 'list_workspace_calendar_events':
            assertCalendarEventParams(args);
            result = await handleListWorkspaceCalendarEvents(args as CalendarEventParams);
            break;
          case 'get_workspace_calendar_event':
            assertEmailEventIdArgs(args);
            result = await handleGetWorkspaceCalendarEvent(args);
            break;
          case 'manage_workspace_calendar_event':
            assertBaseToolArguments(args);
            result = await handleManageWorkspaceCalendarEvent(args);
            break;
          case 'respond_to_workspace_calendar_event':
            assertBaseToolArguments(args);
            result = await handleManageWorkspaceCalendarEvent(args);
            break;
          case 'create_workspace_calendar_event':
            assertBaseToolArguments(args);
            result = await handleCreateWorkspaceCalendarEvent(args);
            break;
          case 'delete_workspace_calendar_event':
            assertEmailEventIdArgs(args);
            result = await handleDeleteWorkspaceCalendarEvent(args);
            break;

          // Individual Label Operations
          case 'list_workspace_labels':
            assertBaseToolArguments(args);
            result = await handleListWorkspaceLabels(args);
            break;
          case 'get_workspace_label':
            assertBaseToolArguments(args);
            result = await handleGetWorkspaceLabel(args as { email?: string; labelId: string });
            break;
          case 'create_workspace_label':
            assertBaseToolArguments(args);
            result = await handleCreateWorkspaceLabel(args);
            break;
          case 'update_workspace_label':
            assertBaseToolArguments(args);
            result = await handleUpdateWorkspaceLabel(args);
            break;
          case 'delete_workspace_label':
            assertBaseToolArguments(args);
            result = await handleDeleteWorkspaceLabel(args as { email?: string; labelId: string });
            break;

          // Individual Label Filter Operations
          case 'list_workspace_label_filters':
            assertBaseToolArguments(args);
            result = await handleListWorkspaceLabelFilters(args as { email?: string; labelId?: string });
            break;
          case 'create_workspace_label_filter':
            assertBaseToolArguments(args);
            result = await handleCreateWorkspaceLabelFilter(args);
            break;
          case 'update_workspace_label_filter':
            assertBaseToolArguments(args);
            result = await handleUpdateWorkspaceLabelFilter(args);
            break;
          case 'delete_workspace_label_filter':
            assertBaseToolArguments(args);
            result = await handleDeleteWorkspaceLabelFilter(args as { email?: string; filterId: string });
            break;

          // Label Management (deprecated)
          case 'manage_workspace_label':
            assertManageLabelParams(args);
            result = await handleManageWorkspaceLabel(args as unknown as ManageLabelParams);
            break;
          case 'manage_workspace_label_assignment':
            assertManageLabelAssignmentParams(args);
            result = await handleManageWorkspaceLabelAssignment(args as unknown as ManageLabelAssignmentParams);
            break;
          case 'manage_workspace_label_filter':
            assertManageLabelFilterParams(args);
            result = await handleManageWorkspaceLabelFilter(args as unknown as ManageLabelFilterParams);
            break;

          // Drive Operations
          case 'list_drive_files':
            assertDriveFileListArgs(args);
            result = await handleListDriveFiles(args);
            break;
          case 'search_drive_files':
            assertDriveSearchArgs(args);
            result = await handleSearchDriveFiles(args);
            break;
          case 'upload_drive_file':
            assertDriveUploadArgs(args);
            result = await handleUploadDriveFile(args);
            break;
          case 'download_drive_file':
            assertDriveDownloadArgs(args);
            result = await handleDownloadDriveFile(args);
            break;
          case 'create_drive_folder':
            assertDriveFolderArgs(args);
            result = await handleCreateDriveFolder(args);
            break;
          case 'update_drive_permissions':
            assertDrivePermissionArgs(args);
            result = await handleUpdateDrivePermissions(args);
            break;
          case 'delete_drive_file':
            assertDriveDeleteArgs(args);
            result = await handleDeleteDriveFile(args);
            break;
          case 'copy_drive_file':
            assertDriveCopyArgs(args);
            result = await handleCopyDriveFile(args);
            break;
          case 'move_drive_file':
            assertDriveMoveArgs(args);
            result = await handleMoveDriveFile(args);
            break;
          case 'trash_drive_file':
            assertDriveTrashArgs(args);
            result = await handleTrashDriveFile(args);
            break;
          case 'untrash_drive_file':
            assertDriveTrashArgs(args);
            result = await handleUntrashDriveFile(args);
            break;
          case 'list_file_revisions':
            assertDriveRevisionsArgs(args);
            result = await handleListFileRevisions(args);
            break;
          case 'download_file_revision':
            assertDriveDownloadRevisionArgs(args);
            result = await handleDownloadFileRevision(args);
            break;

          // Contact Operations
          case 'get_workspace_contacts':
            assertGetContactsParams(args);
            result = await handleGetContacts(args);
            break;
          case 'search_workspace_contacts':
            assertBaseToolArguments(args);
            result = await handleSearchContacts(args as { email: string; query: string; max_results?: number; maxResults?: number; returnJson?: boolean });
            break;

          // Google Docs Operations
          case 'read_workspace_document':
            assertReadDocumentArgs(args);
            result = await handleReadDocument(args);
            break;
          case 'create_workspace_document':
            assertCreateDocumentArgs(args);
            result = await handleCreateDocument(args);
            break;
          case 'append_to_workspace_document':
            assertAppendDocumentArgs(args);
            result = await handleAppendDocument(args);
            break;
          case 'replace_workspace_document':
            assertReplaceDocumentArgs(args);
            result = await handleReplaceDocument(args);
            break;
          case 'find_and_replace_workspace_document':
            assertFindReplaceArgs(args);
            result = await handleFindAndReplace(args);
            break;
          case 'extract_workspace_document_id':
            assertExtractIdArgs(args);
            result = await handleExtractDocumentId(args);
            break;
          case 'list_workspace_document_tabs':
            assertListTabsArgs(args);
            result = await handleListDocumentTabs(args);
            break;
          case 'batch_update_workspace_document':
            assertBatchUpdateDocumentArgs(args);
            result = await handleBatchUpdateDocument(args);
            break;

          // Google Slides Operations
          case 'read_workspace_presentation':
            assertReadPresentationArgs(args);
            result = await handleReadPresentation(args);
            break;
          case 'create_workspace_presentation':
            assertCreatePresentationArgs(args);
            result = await handleCreatePresentation(args);
            break;
          case 'list_workspace_presentation_slides':
            assertListSlidesArgs(args);
            result = await handleListSlides(args);
            break;
          case 'get_workspace_slide':
            assertGetSlideArgs(args);
            result = await handleGetSlide(args);
            break;
          case 'extract_workspace_presentation_id':
            assertExtractPresentationIdArgs(args);
            result = await handleExtractPresentationId(args);
            break;
          case 'batch_update_workspace_presentation':
            assertBatchUpdatePresentationArgs(args);
            result = await handleBatchUpdatePresentation(args);
            break;
          case 'get_workspace_slide_thumbnail':
            assertGetSlideThumbnailArgs(args);
            result = await handleGetSlideThumbnail(args);
            break;

          // Drive Comments Operations
          case 'list_workspace_comments':
            assertListCommentsArgs(args);
            result = await handleListComments(args);
            break;
          case 'create_workspace_comment':
            assertCreateCommentArgs(args);
            result = await handleCreateComment(args);
            break;
          case 'resolve_workspace_comment':
            assertResolveCommentArgs(args);
            result = await handleResolveComment(args);
            break;
          case 'reply_to_workspace_comment':
            assertReplyToCommentArgs(args);
            result = await handleReplyToComment(args);
            break;
          case 'delete_workspace_comment':
            assertDeleteCommentArgs(args);
            result = await handleDeleteComment(args);
            break;

          // Google Sheets Operations
          case 'read_workspace_spreadsheet':
            assertReadSpreadsheetArgs(args);
            result = await handleReadSpreadsheet(args as {
              email?: string;
              spreadsheet_id?: string;
              spreadsheetId?: string;
              range?: string;
              max_rows?: number;
              maxRows?: number;
              max_cols?: number;
              maxCols?: number;
              return_json?: boolean;
              returnJson?: boolean;
              value_view?: 'formatted' | 'shaped' | 'formula' | 'unformatted';
              valueView?: 'formatted' | 'shaped' | 'formula' | 'unformatted';
              anchor_mode?: 'auto' | 'always' | 'never';
              anchorMode?: 'auto' | 'always' | 'never';
              continuation_token?: string;
              continuationToken?: string;
            });
            break;
          case 'read_workspace_spreadsheet_values':
            assertReadSpreadsheetValuesArgs(args);
            result = await handleReadSpreadsheetValues(args as {
              email?: string;
              spreadsheet_id?: string;
              spreadsheetId?: string;
              range: string;
              major_dimension?: 'ROWS' | 'COLUMNS';
              majorDimension?: 'ROWS' | 'COLUMNS';
              return_json?: boolean;
              returnJson?: boolean;
              value_view?: 'formatted' | 'shaped' | 'formula' | 'unformatted';
              valueView?: 'formatted' | 'shaped' | 'formula' | 'unformatted';
              anchor_mode?: 'auto' | 'always' | 'never';
              anchorMode?: 'auto' | 'always' | 'never';
              continuation_token?: string;
              continuationToken?: string;
            });
            break;
          case 'create_workspace_spreadsheet':
            assertCreateSpreadsheetArgs(args);
            result = await handleCreateSpreadsheet(args);
            break;
          case 'append_to_workspace_spreadsheet':
            assertAppendSpreadsheetArgs(args);
            result = await handleAppendValues(args as {
              email?: string;
              spreadsheet_id?: string;
              spreadsheetId?: string;
              range: string;
              values: (string | number | boolean | null)[][];
              value_input_option?: 'RAW' | 'USER_ENTERED';
              valueInputOption?: 'RAW' | 'USER_ENTERED';
              overwrite_formulas?: boolean;
              overwriteFormulas?: boolean;
            });
            break;
          case 'update_workspace_spreadsheet_values':
            assertUpdateSpreadsheetValuesArgs(args);
            result = await handleUpdateValues(args as {
              email?: string;
              spreadsheet_id?: string;
              spreadsheetId?: string;
              range: string;
              values: (string | number | boolean | null)[][];
              value_input_option?: 'RAW' | 'USER_ENTERED';
              valueInputOption?: 'RAW' | 'USER_ENTERED';
              overwrite_formulas?: boolean;
              overwriteFormulas?: boolean;
            });
            break;
          case 'clear_workspace_spreadsheet_values':
            assertClearSpreadsheetValuesArgs(args);
            result = await handleClearValues(args);
            break;
          case 'list_workspace_spreadsheet_sheets':
            assertListSpreadsheetSheetsArgs(args);
            result = await handleListSheets(args);
            break;
          case 'add_workspace_spreadsheet_sheet':
            assertAddSpreadsheetSheetArgs(args);
            result = await handleAddSheet(args);
            break;
          case 'delete_workspace_spreadsheet_sheet':
            assertDeleteSpreadsheetSheetArgs(args);
            result = await handleDeleteSheet(args);
            break;
          case 'extract_workspace_spreadsheet_id':
            assertExtractSpreadsheetIdArgs(args);
            result = await handleExtractSpreadsheetId(args);
            break;
          case 'batch_read_workspace_spreadsheet_values':
            assertBatchGetSpreadsheetValuesArgs(args);
            result = await handleBatchGetValues(args as {
              email?: string;
              spreadsheet_id?: string;
              spreadsheetId?: string;
              ranges: string[];
              major_dimension?: 'ROWS' | 'COLUMNS';
              majorDimension?: 'ROWS' | 'COLUMNS';
              return_json?: boolean;
              returnJson?: boolean;
              value_view?: 'formatted' | 'shaped' | 'formula' | 'unformatted';
              valueView?: 'formatted' | 'shaped' | 'formula' | 'unformatted';
              anchor_mode?: 'auto' | 'always' | 'never';
              anchorMode?: 'auto' | 'always' | 'never';
              continuation_token?: string;
              continuationToken?: string;
            });
            break;
          case 'batch_update_workspace_spreadsheet_values':
            assertBatchUpdateSpreadsheetValuesArgs(args);
            result = await handleBatchUpdateValues(args as {
              email?: string;
              spreadsheet_id?: string;
              spreadsheetId?: string;
              data: { range: string; values: (string | number | boolean | null)[][] }[];
              value_input_option?: 'RAW' | 'USER_ENTERED';
              valueInputOption?: 'RAW' | 'USER_ENTERED';
              overwrite_formulas?: boolean;
              overwriteFormulas?: boolean;
            });
            break;
          case 'find_and_replace_workspace_spreadsheet':
            assertFindReplaceSpreadsheetArgs(args);
            result = await handleFindReplace(args as { email: string; spreadsheetId: string; find: string; replacement: string; sheetId?: number; matchCase?: boolean; matchEntireCell?: boolean; searchByRegex?: boolean; includeFormulas?: boolean });
            break;
          case 'format_workspace_spreadsheet_cells':
            assertFormatSpreadsheetCellsArgs(args);
            result = await handleFormatCells(args as { email: string; spreadsheetId: string; sheetId: number; startRowIndex: number; endRowIndex: number; startColumnIndex: number; endColumnIndex: number; bold?: boolean; italic?: boolean; underline?: boolean; strikethrough?: boolean; fontSize?: number; textColor?: { red?: number; green?: number; blue?: number }; backgroundColor?: { red?: number; green?: number; blue?: number }; borderStyle?: 'NONE' | 'DOTTED' | 'DASHED' | 'SOLID' | 'SOLID_MEDIUM' | 'SOLID_THICK' | 'DOUBLE'; borderColor?: { red?: number; green?: number; blue?: number } });
            break;

          // Google Tasks Operations
          case 'list_task_lists':
            assertListTaskListsArgs(args);
            result = await handleListTaskLists(args);
            break;
          case 'list_tasks':
            assertListTasksArgs(args);
            result = await handleListTasks(args);
            break;
          case 'create_task':
            assertCreateTaskArgs(args);
            result = await handleCreateTask(args);
            break;
          case 'update_task':
            assertUpdateTaskArgs(args);
            result = await handleUpdateTask(args);
            break;
          case 'complete_task':
            assertCompleteTaskArgs(args);
            result = await handleCompleteTask(args);
            break;
          case 'delete_task':
            assertDeleteTaskArgs(args);
            result = await handleDeleteTask(args);
            break;

          // Google Forms Operations (read-only)
          case 'list_forms':
            assertListFormsArgs(args);
            result = await handleListForms(args);
            break;
          case 'get_form':
            assertGetFormArgs(args);
            result = await handleGetForm(args);
            break;
          case 'list_form_responses':
            assertListFormResponsesArgs(args);
            result = await handleListFormResponses(args);
            break;
          case 'get_form_response':
            assertGetFormResponseArgs(args);
            result = await handleGetFormResponse(args);
            break;

          default:
            throw new Error(`Unknown tool: ${request.params.name}`);
        }

        // Wrap result in McpToolResponse format
        // Handle different result types appropriately:
        // - undefined: return success message
        // - string: return as-is (pre-formatted text from handlers)
        // - object: JSON stringify (compact to save tokens)
        if (isInlineUiToolResult(result)) {
          return {
            content: [{
              type: 'text',
              text: result.text
            }],
            ...(result.structuredContent !== undefined
              ? { structuredContent: result.structuredContent }
              : {}),
            _meta: result._meta ?? {}
          };
        }

        if (isMcpToolResponseResult(result)) {
          return result;
        }

        let responseText: string;
        if (result === undefined) {
          responseText = JSON.stringify({ status: 'success', message: 'Operation completed successfully' });
        } else if (typeof result === 'string') {
          // String results are pre-formatted - don't double-stringify
          responseText = result;
        } else {
          // Objects get compact JSON (no pretty-print to save tokens)
          responseText = JSON.stringify(result);
        }
        
        return {
          content: [{
            type: 'text',
            text: responseText
          }],
          _meta: extractResultMeta(result)
        };
      } catch (error) {
        const response = this.formatErrorResponse(error);
        return {
          content: [{ type: 'text', text: JSON.stringify(response, null, 2) }],
          isError: true,
          _meta: {}
        };
      }
    });
  }

  private formatErrorResponse(error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error occurred';
    const code = error instanceof AccountError ? error.code : undefined;
    const status = typeof error === 'object' && error !== null
      ? (error as { response?: { status?: unknown }; status?: unknown; code?: unknown }).response?.status
        ?? (error as { response?: { status?: unknown }; status?: unknown; code?: unknown }).status
        ?? (error as { response?: { status?: unknown }; status?: unknown; code?: unknown }).code
      : undefined;
    const numericStatus = typeof status === 'number'
      ? status
      : typeof status === 'string' && /^\d+$/.test(status)
        ? Number(status)
        : undefined;

    if (code === 'AUTH_REQUIRED' || code === 'HOST_ORCHESTRATED_AUTH_REQUIRED') {
      return {
        status: 'auth_required',
        user_action: { id: 'google.connect_account' },
        agent_action: {
          instruction: "Connect Google Workspace to continue. The user will be redirected to Google's sign-in."
        },
        setupToolName: 'authenticate_workspace_account'
      };
    }

    if (numericStatus === 401) {
      return {
        status: 'auth_required',
        user_action: { id: 'google.connect_account' },
        agent_action: {
          instruction: "Connect Google Workspace to continue. The user will be redirected to Google's sign-in."
        },
        setupToolName: 'authenticate_workspace_account'
      };
    }

    if (numericStatus === 403) {
      return {
        ok: false,
        action_required: message,
        next_step: 'Google Workspace rejected the request due to insufficient permissions or scopes. Reconnect the account with the required scope or ask the file/calendar owner for access, then retry.'
      };
    }

    if (numericStatus === 429) {
      return {
        ok: false,
        action_required: message,
        next_step: 'Google Workspace rate limit reached. Back off before retrying, reduce the request size if possible, then try again.'
      };
    }

    if (numericStatus !== undefined && numericStatus >= 500 && numericStatus <= 599) {
      return {
        ok: false,
        action_required: message,
        next_step: 'Google Workspace returned a temporary server error. Retry after a short delay; if it keeps failing, narrow the request and try again.'
      };
    }

    const nextStep = error instanceof AccountError ? error.resolution :
      error instanceof GmailError ? error.details :
      error instanceof CalendarError ? error.message :
      error instanceof ContactsError ? error.details :
      'Review the error, adjust the request if needed, and retry.';

    return {
      ok: false,
      action_required: message,
      next_step: nextStep || 'Review the error, adjust the request if needed, and retry.'
    };
  }

  async run(): Promise<void> {
    try {
      // Initialize server
      logger.info(`google-workspace-mcp v${SERVER_VERSION}`);
      
      // Initialize all services
      await initializeAllServices();
      
      // Set up error handler
      this.server.onerror = (error) => console.error('MCP Error:', error);
      
      // Connect transport
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      logger.info('Google Workspace MCP server running on stdio');
    } catch (error) {
      logger.error('Fatal server error:', error);
      throw error;
    }
  }
}
