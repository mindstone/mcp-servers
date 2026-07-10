import {
BaseToolArguments,
  ListCalendarsArgs,
  CalendarEventParams,
  SendEmailArgs,
  ManageLabelParams,
  ManageLabelAssignmentParams,
  ManageLabelFilterParams,
  ManageDraftParams,
  DriveFileListArgs,
  DriveSearchArgs,
  ListSharedDrivesArgs,
  DriveUploadArgs,
  DriveDownloadArgs,
  DriveFolderArgs,
  DrivePermissionArgs,
  DriveDeleteArgs,
  ManageAttachmentParams
} from './types.js';
import { GetContactsParams } from '../modules/contacts/types.js';

// Base Tool Arguments
// Email is now optional - resolveEmail() will handle fallback to instance account
export function isBaseToolArguments(args: Record<string, unknown>): args is BaseToolArguments {
  return args.email === undefined || typeof args.email === 'string';
}

export function assertBaseToolArguments(args: Record<string, unknown>): asserts args is BaseToolArguments {
  if (!isBaseToolArguments(args)) {
    throw new Error('Invalid email parameter - must be a string or undefined');
  }
}

function readAliasedArg<T>(
  args: Record<string, unknown>,
  canonicalKey: string,
  legacyKey: string
): T | undefined {
  return (args[canonicalKey] ?? args[legacyKey]) as T | undefined;
}

// Calendar Type Guards
export function isListCalendarsArgs(args: Record<string, unknown>): args is ListCalendarsArgs {
  return args.email === undefined || typeof args.email === 'string';
}

export function assertListCalendarsArgs(args: Record<string, unknown>): asserts args is ListCalendarsArgs {
  if (!isListCalendarsArgs(args)) {
    throw new Error('Invalid list calendars parameters - email must be a string or undefined');
  }
}
export function isCalendarEventParams(args: Record<string, unknown>): args is CalendarEventParams {
  const maxResults = readAliasedArg<number>(args, 'max_results', 'maxResults');
  const timeMin = readAliasedArg<string>(args, 'time_min', 'timeMin');
  const timeMax = readAliasedArg<string>(args, 'time_max', 'timeMax');
  const calendarId = readAliasedArg<string>(args, 'calendar_id', 'calendarId');

  return (args.email === undefined || typeof args.email === 'string') &&
    (args.query === undefined || typeof args.query === 'string') &&
    (maxResults === undefined || typeof maxResults === 'number') &&
    (timeMin === undefined || typeof timeMin === 'string') &&
    (timeMax === undefined || typeof timeMax === 'string') &&
    (calendarId === undefined || typeof calendarId === 'string');
}

export function assertCalendarEventParams(args: Record<string, unknown>): asserts args is CalendarEventParams {
  if (!isCalendarEventParams(args)) {
    throw new Error('Invalid calendar event parameters');
  }
}

interface EmailEventIdArgs extends Record<string, unknown> {
  email?: string;
  event_id?: string;
  eventId?: string;
  calendar_id?: string;
  calendarId?: string;
}

export function isEmailEventIdArgs(args: Record<string, unknown>): args is EmailEventIdArgs {
  const eventId = readAliasedArg<string>(args, 'event_id', 'eventId');
  const calendarId = readAliasedArg<string>(args, 'calendar_id', 'calendarId');

  return (args.email === undefined || typeof args.email === 'string') && 
    typeof eventId === 'string' &&
    (calendarId === undefined || typeof calendarId === 'string');
}

export function assertEmailEventIdArgs(args: Record<string, unknown>): asserts args is EmailEventIdArgs {
  if (!isEmailEventIdArgs(args)) {
    throw new Error('Missing required email or event_id parameter');
  }
}

// Shared attachment array validator — checks both key existence and value types
function isValidAttachmentsArray(attachments: unknown): boolean {
  if (!Array.isArray(attachments)) return false;
  return attachments.every(a => {
    if (typeof a !== 'object' || a === null) return false;
    const att = a as Record<string, unknown>;
    // Path-based: path is the only required field; all others auto-resolved by resolveAttachmentFromPath()
    if (typeof att.path === 'string') {
      // Validate optional field types when present
      if (att.content !== undefined && typeof att.content !== 'string') return false;
      if (att.name !== undefined && typeof att.name !== 'string') return false;
      if (att.mimeType !== undefined && typeof att.mimeType !== 'string') return false;
      if (att.size !== undefined && typeof att.size !== 'number') return false;
      if (att.id !== undefined && typeof att.id !== 'string') return false;
      return true;
    }
    // Content-based: content + name required (mimeType defaults downstream)
    if (typeof att.content === 'string' && typeof att.name === 'string') {
      if (att.mimeType !== undefined && typeof att.mimeType !== 'string') return false;
      if (att.size !== undefined && typeof att.size !== 'number') return false;
      if (att.id !== undefined && typeof att.id !== 'string') return false;
      return true;
    }
    // Legacy full-field: backwards compatible (all 5 original fields present)
    return typeof att.id === 'string' &&
      typeof att.name === 'string' &&
      typeof att.mimeType === 'string' &&
      typeof att.size === 'number' &&
      typeof att.content === 'string';
  });
}

// Gmail Type Guards
export function isSendEmailArgs(args: Record<string, unknown>): args is SendEmailArgs {
  const isHtml = readAliasedArg<boolean>(args, 'is_html', 'isHtml');
  const replyToMessageId = readAliasedArg<string>(args, 'reply_to_message_id', 'replyToMessageId');

  return (args.email === undefined || typeof args.email === 'string') &&
    Array.isArray(args.to) &&
    args.to.every(to => typeof to === 'string') &&
    typeof args.subject === 'string' &&
    typeof args.body === 'string' &&
    (args.cc === undefined || (Array.isArray(args.cc) && args.cc.every(cc => typeof cc === 'string'))) &&
    (args.bcc === undefined || (Array.isArray(args.bcc) && args.bcc.every(bcc => typeof bcc === 'string'))) &&
    (isHtml === undefined || typeof isHtml === 'boolean') &&
    (replyToMessageId === undefined || typeof replyToMessageId === 'string') &&
    (args.attachments === undefined || isValidAttachmentsArray(args.attachments));
}

export function assertSendEmailArgs(args: Record<string, unknown>): asserts args is SendEmailArgs {
  if (!isSendEmailArgs(args)) {
    throw new Error('Invalid email parameters. Required: email, to, subject, body');
  }
}

// Drive Type Guards
const DRIVE_CORPORA_VALUES = ['user', 'drive', 'allDrives'];

function isValidCorpora(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && DRIVE_CORPORA_VALUES.includes(value));
}

export function isDriveFileListArgs(args: unknown): args is DriveFileListArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<DriveFileListArgs>;

  return (params.email === undefined || typeof params.email === 'string') &&
    (params.options === undefined || (() => {
      const opts = params.options as any;
      return (opts.folderId === undefined || typeof opts.folderId === 'string') &&
        (opts.query === undefined || typeof opts.query === 'string') &&
        (opts.pageSize === undefined || typeof opts.pageSize === 'number') &&
        (opts.orderBy === undefined || (Array.isArray(opts.orderBy) && opts.orderBy.every((o: unknown) => typeof o === 'string'))) &&
        (opts.fields === undefined || (Array.isArray(opts.fields) && opts.fields.every((f: unknown) => typeof f === 'string'))) &&
        (opts.driveId === undefined || typeof opts.driveId === 'string') &&
        isValidCorpora(opts.corpora);
    })());
}

export function assertDriveFileListArgs(args: unknown): asserts args is DriveFileListArgs {
  if (!isDriveFileListArgs(args)) {
    throw new Error('Invalid file list parameters. Required: email');
  }
}

export function isDriveSearchArgs(args: unknown): args is DriveSearchArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<DriveSearchArgs>;
  
  return (params.email === undefined || typeof params.email === 'string') &&
    typeof params.options === 'object' && params.options !== null &&
    (params.options.fullText === undefined || typeof params.options.fullText === 'string') &&
    (params.options.mimeType === undefined || typeof params.options.mimeType === 'string') &&
    (params.options.folderId === undefined || typeof params.options.folderId === 'string') &&
    (params.options.trashed === undefined || typeof params.options.trashed === 'boolean') &&
    (params.options.query === undefined || typeof params.options.query === 'string') &&
    (params.options.pageSize === undefined || typeof params.options.pageSize === 'number') &&
    (params.options.driveId === undefined || typeof params.options.driveId === 'string') &&
    isValidCorpora(params.options.corpora);
}

export function assertDriveSearchArgs(args: unknown): asserts args is DriveSearchArgs {
  if (!isDriveSearchArgs(args)) {
    throw new Error('Invalid search parameters. Required: email, options');
  }
}

export function isListSharedDrivesArgs(args: Record<string, unknown>): args is ListSharedDrivesArgs {
  const pageSize = readAliasedArg<number>(args, 'page_size', 'pageSize');
  const pageToken = readAliasedArg<string>(args, 'page_token', 'pageToken');

  return (args.email === undefined || typeof args.email === 'string') &&
    (pageSize === undefined || typeof pageSize === 'number') &&
    (pageToken === undefined || typeof pageToken === 'string');
}

export function assertListSharedDrivesArgs(args: Record<string, unknown>): asserts args is ListSharedDrivesArgs {
  if (!isListSharedDrivesArgs(args)) {
    throw new Error('Invalid list shared drives parameters - page_size must be a number and page_token a string when provided');
  }
}

export function isDriveUploadArgs(args: unknown): args is DriveUploadArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<DriveUploadArgs>;
  
  return (params.email === undefined || typeof params.email === 'string') &&
    typeof params.options === 'object' && params.options !== null &&
    typeof params.options.name === 'string' &&
    typeof params.options.content === 'string' &&
    (params.options.mimeType === undefined || typeof params.options.mimeType === 'string') &&
    (params.options.parents === undefined || (Array.isArray(params.options.parents) && params.options.parents.every(p => typeof p === 'string')));
}

export function assertDriveUploadArgs(args: unknown): asserts args is DriveUploadArgs {
  if (!isDriveUploadArgs(args)) {
    throw new Error('Invalid upload parameters. Required: email, options.name, options.content');
  }
}

export function isDriveDownloadArgs(args: unknown): args is DriveDownloadArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<DriveDownloadArgs>;
  const rawParams = args as Record<string, unknown>;
  const fileId = readAliasedArg<string>(rawParams, 'file_id', 'fileId');
  const mimeType = readAliasedArg<string>(rawParams, 'mime_type', 'mimeType');
  
  return (params.email === undefined || typeof params.email === 'string') &&
    typeof fileId === 'string' &&
    (mimeType === undefined || typeof mimeType === 'string');
}

export function assertDriveDownloadArgs(args: unknown): asserts args is DriveDownloadArgs {
  if (!isDriveDownloadArgs(args)) {
    throw new Error('Invalid download parameters. Required: email, file_id');
  }
}

export function isDriveFolderArgs(args: unknown): args is DriveFolderArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<DriveFolderArgs>;
  const parentId = readAliasedArg<string>(args as Record<string, unknown>, 'parent_id', 'parentId');
  
  return (params.email === undefined || typeof params.email === 'string') &&
    typeof params.name === 'string' &&
    (parentId === undefined || typeof parentId === 'string');
}

export function assertDriveFolderArgs(args: unknown): asserts args is DriveFolderArgs {
  if (!isDriveFolderArgs(args)) {
    throw new Error('Invalid folder parameters. Required: email, name');
  }
}

export function isDrivePermissionArgs(args: unknown): args is DrivePermissionArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<DrivePermissionArgs>;
  
  return (params.email === undefined || typeof params.email === 'string') &&
    typeof params.options === 'object' && params.options !== null &&
    typeof params.options.fileId === 'string' &&
    ['owner', 'organizer', 'fileOrganizer', 'writer', 'commenter', 'reader'].includes(params.options.role) &&
    ['user', 'group', 'domain', 'anyone'].includes(params.options.type) &&
    (params.options.emailAddress === undefined || typeof params.options.emailAddress === 'string') &&
    (params.options.domain === undefined || typeof params.options.domain === 'string') &&
    (params.options.allowFileDiscovery === undefined || typeof params.options.allowFileDiscovery === 'boolean');
}

export function assertDrivePermissionArgs(args: unknown): asserts args is DrivePermissionArgs {
  if (!isDrivePermissionArgs(args)) {
    throw new Error('Invalid permission parameters. Required: email, options.fileId, options.role, options.type');
  }
}

export function isDriveDeleteArgs(args: unknown): args is DriveDeleteArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<DriveDeleteArgs>;
  const fileId = readAliasedArg<string>(args as Record<string, unknown>, 'file_id', 'fileId');
  
  return (params.email === undefined || typeof params.email === 'string') &&
    typeof fileId === 'string';
}

export function assertDriveDeleteArgs(args: unknown): asserts args is DriveDeleteArgs {
  if (!isDriveDeleteArgs(args)) {
    throw new Error('Invalid delete parameters. Required: email, file_id');
  }
}

// Drive Copy, Move, Trash, Untrash, Revisions Type Guards
interface DriveCopyArgs {
  email?: string;
  fileId: string;
  name?: string;
  parentId?: string;
}

export function isDriveCopyArgs(args: unknown): args is DriveCopyArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<DriveCopyArgs>;
  const rawParams = args as Record<string, unknown>;
  const fileId = readAliasedArg<string>(rawParams, 'file_id', 'fileId');
  const parentId = readAliasedArg<string>(rawParams, 'parent_id', 'parentId');
  
  return (params.email === undefined || typeof params.email === 'string') &&
    typeof fileId === 'string' &&
    (params.name === undefined || typeof params.name === 'string') &&
    (parentId === undefined || typeof parentId === 'string');
}

export function assertDriveCopyArgs(args: unknown): asserts args is DriveCopyArgs {
  if (!isDriveCopyArgs(args)) {
    throw new Error('Invalid copy parameters. Required: file_id');
  }
}

interface DriveMoveArgs {
  email?: string;
  fileId: string;
  newParentId: string;
  removeFromParents?: string;
}

export function isDriveMoveArgs(args: unknown): args is DriveMoveArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<DriveMoveArgs>;
  const rawParams = args as Record<string, unknown>;
  const fileId = readAliasedArg<string>(rawParams, 'file_id', 'fileId');
  const newParentId = readAliasedArg<string>(rawParams, 'new_parent_id', 'newParentId');
  const removeFromParents = readAliasedArg<string>(rawParams, 'remove_from_parents', 'removeFromParents');
  
  return (params.email === undefined || typeof params.email === 'string') &&
    typeof fileId === 'string' &&
    typeof newParentId === 'string' &&
    (removeFromParents === undefined || typeof removeFromParents === 'string');
}

export function assertDriveMoveArgs(args: unknown): asserts args is DriveMoveArgs {
  if (!isDriveMoveArgs(args)) {
    throw new Error('Invalid move parameters. Required: file_id, new_parent_id');
  }
}

interface DriveTrashArgs {
  email?: string;
  fileId: string;
}

export function isDriveTrashArgs(args: unknown): args is DriveTrashArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<DriveTrashArgs>;
  const fileId = readAliasedArg<string>(args as Record<string, unknown>, 'file_id', 'fileId');
  
  return (params.email === undefined || typeof params.email === 'string') &&
    typeof fileId === 'string';
}

export function assertDriveTrashArgs(args: unknown): asserts args is DriveTrashArgs {
  if (!isDriveTrashArgs(args)) {
    throw new Error('Invalid trash/untrash parameters. Required: file_id');
  }
}

interface DriveRevisionsArgs {
  email?: string;
  fileId: string;
}

export function isDriveRevisionsArgs(args: unknown): args is DriveRevisionsArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<DriveRevisionsArgs>;
  const fileId = readAliasedArg<string>(args as Record<string, unknown>, 'file_id', 'fileId');
  
  return (params.email === undefined || typeof params.email === 'string') &&
    typeof fileId === 'string';
}

export function assertDriveRevisionsArgs(args: unknown): asserts args is DriveRevisionsArgs {
  if (!isDriveRevisionsArgs(args)) {
    throw new Error('Invalid revisions parameters. Required: file_id');
  }
}

interface DriveDownloadRevisionArgs {
  email?: string;
  fileId: string;
  revisionId: string;
}

export function isDriveDownloadRevisionArgs(args: unknown): args is DriveDownloadRevisionArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<DriveDownloadRevisionArgs>;
  const rawParams = args as Record<string, unknown>;
  const fileId = readAliasedArg<string>(rawParams, 'file_id', 'fileId');
  const revisionId = readAliasedArg<string>(rawParams, 'revision_id', 'revisionId');
  
  return (params.email === undefined || typeof params.email === 'string') &&
    typeof fileId === 'string' &&
    typeof revisionId === 'string';
}

export function assertDriveDownloadRevisionArgs(args: unknown): asserts args is DriveDownloadRevisionArgs {
  if (!isDriveDownloadRevisionArgs(args)) {
    throw new Error('Invalid download revision parameters. Required: file_id, revision_id');
  }
}

// Label Management Type Guards
export function isManageLabelParams(args: unknown): args is ManageLabelParams {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<ManageLabelParams>;
  const rawParams = args as Record<string, unknown>;
  const labelId = readAliasedArg<string>(rawParams, 'label_id', 'labelId');
  const messageListVisibility = readAliasedArg<string>(rawParams, 'message_list_visibility', 'messageListVisibility');
  const labelListVisibility = readAliasedArg<string>(rawParams, 'label_list_visibility', 'labelListVisibility');
  
  return (params.email === undefined || typeof params.email === 'string') &&
    typeof params.action === 'string' &&
    ['create', 'read', 'update', 'delete'].includes(params.action) &&
    (labelId === undefined || typeof labelId === 'string') &&
    (messageListVisibility === undefined || ['show', 'hide'].includes(messageListVisibility)) &&
    (labelListVisibility === undefined || ['labelShow', 'labelHide', 'labelShowIfUnread'].includes(labelListVisibility)) &&
    (params.data === undefined || (() => {
      if (typeof params.data !== 'object' || params.data === null) return false;
      const data = params.data as {
        name?: string;
        messageListVisibility?: string;
        labelListVisibility?: string;
      };
      return (data.name === undefined || typeof data.name === 'string') &&
        (data.messageListVisibility === undefined || ['show', 'hide'].includes(data.messageListVisibility)) &&
        (data.labelListVisibility === undefined || ['labelShow', 'labelHide', 'labelShowIfUnread'].includes(data.labelListVisibility));
    })());
}

export function assertManageLabelParams(args: unknown): asserts args is ManageLabelParams {
  if (!isManageLabelParams(args)) {
    throw new Error('Invalid label management parameters. Required: email, action');
  }
}

export function isManageLabelAssignmentParams(args: unknown): args is ManageLabelAssignmentParams {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<ManageLabelAssignmentParams>;
  const rawParams = args as Record<string, unknown>;
  const messageId = readAliasedArg<string>(rawParams, 'message_id', 'messageId');
  const labelIds = readAliasedArg<unknown>(rawParams, 'label_ids', 'labelIds');
  
  return (params.email === undefined || typeof params.email === 'string') &&
    typeof params.action === 'string' &&
    ['add', 'remove'].includes(params.action) &&
    typeof messageId === 'string' &&
    Array.isArray(labelIds) &&
    labelIds.every((id: unknown) => typeof id === 'string');
}

export function assertManageLabelAssignmentParams(args: unknown): asserts args is ManageLabelAssignmentParams {
  if (!isManageLabelAssignmentParams(args)) {
    throw new Error('Invalid label assignment parameters. Required: email, action, message_id, label_ids');
  }
}

export function isManageLabelFilterParams(args: unknown): args is ManageLabelFilterParams {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<ManageLabelFilterParams>;
  const rawParams = args as Record<string, unknown>;
  const filterId = readAliasedArg<string>(rawParams, 'filter_id', 'filterId');
  const labelId = readAliasedArg<string>(rawParams, 'label_id', 'labelId');
  
  return (params.email === undefined || typeof params.email === 'string') &&
    typeof params.action === 'string' &&
    ['create', 'read', 'update', 'delete'].includes(params.action) &&
    (filterId === undefined || typeof filterId === 'string') &&
    (labelId === undefined || typeof labelId === 'string') &&
    (params.data === undefined || (() => {
      if (typeof params.data !== 'object' || params.data === null) return false;
      const data = params.data as {
        criteria?: { [key: string]: unknown };
        actions?: { addLabel: boolean; markImportant?: boolean; markRead?: boolean; archive?: boolean };
      };
      return (data.criteria === undefined || (typeof data.criteria === 'object' && data.criteria !== null)) &&
        (data.actions === undefined || (
          typeof data.actions === 'object' &&
          data.actions !== null &&
          typeof data.actions.addLabel === 'boolean'
        ));
    })());
}

export function assertManageLabelFilterParams(args: unknown): asserts args is ManageLabelFilterParams {
  if (!isManageLabelFilterParams(args)) {
    throw new Error('Invalid label filter parameters. Required: email, action');
  }
}

// Draft Management Type Guards
export function isManageDraftParams(args: unknown): args is ManageDraftParams {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<ManageDraftParams>;
  const rawParams = args as Record<string, unknown>;
  const draftId = readAliasedArg<string>(rawParams, 'draft_id', 'draftId');
  
  return (params.email === undefined || typeof params.email === 'string') &&
    typeof params.action === 'string' &&
    ['create', 'read', 'update', 'delete', 'send'].includes(params.action) &&
    (draftId === undefined || typeof draftId === 'string') &&
    (params.data === undefined || (() => {
      if (typeof params.data !== 'object' || params.data === null) return false;
      const data = params.data as {
        to?: string[];
        subject?: string;
        body?: string;
        cc?: string[];
        bcc?: string[];
        isHtml?: boolean;
        attachments?: unknown;
        replyToMessageId?: string;
        threadId?: string;
        references?: string[];
        inReplyTo?: string;
      };
      return (data.to === undefined || (Array.isArray(data.to) && data.to.every(to => typeof to === 'string'))) &&
        (data.subject === undefined || typeof data.subject === 'string') &&
        (data.body === undefined || typeof data.body === 'string') &&
        (data.cc === undefined || (Array.isArray(data.cc) && data.cc.every(cc => typeof cc === 'string'))) &&
        (data.bcc === undefined || (Array.isArray(data.bcc) && data.bcc.every(bcc => typeof bcc === 'string'))) &&
        (data.isHtml === undefined || typeof data.isHtml === 'boolean') &&
        (data.attachments === undefined || isValidAttachmentsArray(data.attachments)) &&
        (data.replyToMessageId === undefined || typeof data.replyToMessageId === 'string') &&
        (data.threadId === undefined || typeof data.threadId === 'string') &&
        (data.references === undefined || (Array.isArray(data.references) && data.references.every(ref => typeof ref === 'string'))) &&
        (data.inReplyTo === undefined || typeof data.inReplyTo === 'string');
    })());
}

export function isManageAttachmentParams(args: unknown): args is ManageAttachmentParams {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<ManageAttachmentParams>;
  const rawParams = args as Record<string, unknown>;
  const messageId = readAliasedArg<string>(rawParams, 'message_id', 'messageId');
  const mimeType = readAliasedArg<string>(rawParams, 'mime_type', 'mimeType');
  
  return (params.email === undefined || typeof params.email === 'string') &&
    typeof params.action === 'string' &&
    ['download', 'upload', 'delete'].includes(params.action) &&
    typeof params.source === 'string' &&
    ['email', 'calendar'].includes(params.source) &&
    typeof messageId === 'string' &&
    typeof params.filename === 'string' &&
    (mimeType === undefined || typeof mimeType === 'string') &&
    (params.content === undefined || typeof params.content === 'string');
}

export function assertManageAttachmentParams(args: unknown): asserts args is ManageAttachmentParams {
  if (!isManageAttachmentParams(args)) {
    throw new Error('Invalid attachment management parameters. Required: email, action, source, message_id, filename');
  }
}

export function assertManageDraftParams(args: unknown): asserts args is ManageDraftParams {
  if (!isManageDraftParams(args)) {
    throw new Error('Invalid draft management parameters. Required: email, action');
  }
}

// Contacts Type Guards
export function isGetContactsParams(args: unknown): args is GetContactsParams {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<GetContactsParams>;
  const rawParams = args as Record<string, unknown>;
  const personFields = readAliasedArg<string>(rawParams, 'person_fields', 'personFields');
  const pageSize = readAliasedArg<number>(rawParams, 'page_size', 'pageSize');
  const pageToken = readAliasedArg<string>(rawParams, 'page_token', 'pageToken');
  
  return (params.email === undefined || typeof params.email === 'string') &&
    typeof personFields === 'string' &&
    (pageSize === undefined || typeof pageSize === 'number') &&
    (pageToken === undefined || typeof pageToken === 'string');
}

export function assertGetContactsParams(args: unknown): asserts args is GetContactsParams {
  if (!isGetContactsParams(args)) {
    throw new Error('Invalid contacts parameters. Required: email, person_fields');
  }
}

// Docs Type Guards
interface ReadDocumentArgs {
  email: string;
  documentId: string;
  maxChars?: number;
  returnJson?: boolean;
}

interface CreateDocumentArgs {
  email: string;
  title: string;
  content?: string;
}

interface AppendDocumentArgs {
  email: string;
  documentId: string;
  text: string;
}

interface ReplaceDocumentArgs {
  email: string;
  documentId: string;
  content: string;
}

interface FindReplaceArgs {
  email: string;
  documentId: string;
  findText: string;
  replaceText: string;
  matchCase?: boolean;
}

interface ExtractIdArgs {
  input: string;
}

interface ListTabsArgs {
  email: string;
  documentId: string;
  includeWordCount?: boolean;
}

export function isReadDocumentArgs(args: unknown): args is ReadDocumentArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<ReadDocumentArgs>;
  const rawParams = args as Record<string, unknown>;
  const documentId = readAliasedArg<string>(rawParams, 'document_id', 'documentId');
  const maxChars = readAliasedArg<number>(rawParams, 'max_chars', 'maxChars');
  const returnJson = readAliasedArg<boolean>(rawParams, 'return_json', 'returnJson');
  return (params.email === undefined || typeof params.email === 'string') &&
    typeof documentId === 'string' &&
    (maxChars === undefined || typeof maxChars === 'number') &&
    (returnJson === undefined || typeof returnJson === 'boolean');
}

export function assertReadDocumentArgs(args: unknown): asserts args is ReadDocumentArgs {
  if (!isReadDocumentArgs(args)) {
    throw new Error('Invalid read document parameters. Required: email, document_id');
  }
}

export function isCreateDocumentArgs(args: unknown): args is CreateDocumentArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<CreateDocumentArgs>;
  return (params.email === undefined || typeof params.email === 'string') &&
    typeof params.title === 'string' &&
    (params.content === undefined || typeof params.content === 'string');
}

export function assertCreateDocumentArgs(args: unknown): asserts args is CreateDocumentArgs {
  if (!isCreateDocumentArgs(args)) {
    throw new Error('Invalid create document parameters. Required: email, title');
  }
}

export function isAppendDocumentArgs(args: unknown): args is AppendDocumentArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<AppendDocumentArgs>;
  const documentId = readAliasedArg<string>(args as Record<string, unknown>, 'document_id', 'documentId');
  return (params.email === undefined || typeof params.email === 'string') &&
    typeof documentId === 'string' &&
    typeof params.text === 'string';
}

export function assertAppendDocumentArgs(args: unknown): asserts args is AppendDocumentArgs {
  if (!isAppendDocumentArgs(args)) {
    throw new Error('Invalid append document parameters. Required: email, document_id, text');
  }
}

export function isReplaceDocumentArgs(args: unknown): args is ReplaceDocumentArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<ReplaceDocumentArgs>;
  const documentId = readAliasedArg<string>(args as Record<string, unknown>, 'document_id', 'documentId');
  return (params.email === undefined || typeof params.email === 'string') &&
    typeof documentId === 'string' &&
    typeof params.content === 'string';
}

export function assertReplaceDocumentArgs(args: unknown): asserts args is ReplaceDocumentArgs {
  if (!isReplaceDocumentArgs(args)) {
    throw new Error('Invalid replace document parameters. Required: email, document_id, content');
  }
}

export function isFindReplaceArgs(args: unknown): args is FindReplaceArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<FindReplaceArgs>;
  const rawParams = args as Record<string, unknown>;
  const documentId = readAliasedArg<string>(rawParams, 'document_id', 'documentId');
  const findText = readAliasedArg<string>(rawParams, 'find_text', 'findText');
  const replaceText = readAliasedArg<string>(rawParams, 'replace_text', 'replaceText');
  const matchCase = readAliasedArg<boolean>(rawParams, 'match_case', 'matchCase');
  return (params.email === undefined || typeof params.email === 'string') &&
    typeof documentId === 'string' &&
    typeof findText === 'string' &&
    typeof replaceText === 'string' &&
    (matchCase === undefined || typeof matchCase === 'boolean');
}

export function assertFindReplaceArgs(args: unknown): asserts args is FindReplaceArgs {
  if (!isFindReplaceArgs(args)) {
    throw new Error('Invalid find/replace parameters. Required: email, document_id, find_text, replace_text');
  }
}

export function isExtractIdArgs(args: unknown): args is ExtractIdArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<ExtractIdArgs>;
  return typeof params.input === 'string';
}

export function assertExtractIdArgs(args: unknown): asserts args is ExtractIdArgs {
  if (!isExtractIdArgs(args)) {
    throw new Error('Invalid extract ID parameters. Required: input');
  }
}

export function isListTabsArgs(args: unknown): args is ListTabsArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<ListTabsArgs>;
  const rawParams = args as Record<string, unknown>;
  const documentId = readAliasedArg<string>(rawParams, 'document_id', 'documentId');
  const includeWordCount = readAliasedArg<boolean>(rawParams, 'include_word_count', 'includeWordCount');
  return (params.email === undefined || typeof params.email === 'string') &&
    typeof documentId === 'string' &&
    (includeWordCount === undefined || typeof includeWordCount === 'boolean');
}

export function assertListTabsArgs(args: unknown): asserts args is ListTabsArgs {
  if (!isListTabsArgs(args)) {
    throw new Error('Invalid list tabs parameters. Required: email, document_id');
  }
}

// Docs Batch Update Type Guards

interface BatchUpdateDocumentArgs {
  email: string;
  documentId: string;
  requests: object[];
  writeControl?: {
    requiredRevisionId?: string;
  };
  returnJson?: boolean;
}

export function isBatchUpdateDocumentArgs(args: unknown): args is BatchUpdateDocumentArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<BatchUpdateDocumentArgs>;
  const rawParams = args as Record<string, unknown>;
  const documentId = readAliasedArg<string>(rawParams, 'document_id', 'documentId');
  const writeControl = readAliasedArg<Record<string, unknown>>(rawParams, 'write_control', 'writeControl');
  const returnJson = readAliasedArg<boolean>(rawParams, 'return_json', 'returnJson');
  
  // Required fields
  if (params.email !== undefined && typeof params.email !== 'string') return false;
  if (typeof documentId !== 'string') return false;
  
  // requests must be a non-empty array of objects
  if (!Array.isArray(params.requests) || params.requests.length === 0) return false;
  if (!params.requests.every(r => typeof r === 'object' && r !== null)) return false;
  
  // Optional writeControl validation
  if (writeControl !== undefined) {
    if (typeof writeControl !== 'object' || writeControl === null) return false;
    const wc = writeControl as { requiredRevisionId?: unknown };
    if (wc.requiredRevisionId !== undefined && typeof wc.requiredRevisionId !== 'string') return false;
  }
  
  // Optional returnJson validation
  if (returnJson !== undefined && typeof returnJson !== 'boolean') return false;
  
  return true;
}

export function assertBatchUpdateDocumentArgs(args: unknown): asserts args is BatchUpdateDocumentArgs {
  if (!isBatchUpdateDocumentArgs(args)) {
    throw new Error('Invalid batch update document parameters. Required: document_id, requests (non-empty array of objects)');
  }
}

// Slides Type Guards
interface ReadPresentationArgs {
  email: string;
  presentationId: string;
  maxChars?: number;
  includeNotes?: boolean;
  returnJson?: boolean;
}

interface CreatePresentationArgs {
  email: string;
  title: string;
}

interface ListSlidesArgs {
  email: string;
  presentationId: string;
  includeNotes?: boolean;
}

interface GetSlideArgs {
  email: string;
  presentationId: string;
  slideIndex?: number;
  maxChars?: number;
  returnJson?: boolean;
}

interface ExtractPresentationIdArgs {
  input: string;
}

export function isReadPresentationArgs(args: unknown): args is ReadPresentationArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<ReadPresentationArgs>;
  const rawParams = args as Record<string, unknown>;
  const presentationId = readAliasedArg<string>(rawParams, 'presentation_id', 'presentationId');
  const maxChars = readAliasedArg<number>(rawParams, 'max_chars', 'maxChars');
  const includeNotes = readAliasedArg<boolean>(rawParams, 'include_notes', 'includeNotes');
  const returnJson = readAliasedArg<boolean>(rawParams, 'return_json', 'returnJson');
  return (params.email === undefined || typeof params.email === 'string') &&
    typeof presentationId === 'string' &&
    (maxChars === undefined || typeof maxChars === 'number') &&
    (includeNotes === undefined || typeof includeNotes === 'boolean') &&
    (returnJson === undefined || typeof returnJson === 'boolean');
}

export function assertReadPresentationArgs(args: unknown): asserts args is ReadPresentationArgs {
  if (!isReadPresentationArgs(args)) {
    throw new Error('Invalid read presentation parameters. Required: email, presentation_id');
  }
}

export function isCreatePresentationArgs(args: unknown): args is CreatePresentationArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<CreatePresentationArgs>;
  return (params.email === undefined || typeof params.email === 'string') &&
    typeof params.title === 'string';
}

export function assertCreatePresentationArgs(args: unknown): asserts args is CreatePresentationArgs {
  if (!isCreatePresentationArgs(args)) {
    throw new Error('Invalid create presentation parameters. Required: email, title');
  }
}

export function isListSlidesArgs(args: unknown): args is ListSlidesArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<ListSlidesArgs>;
  const rawParams = args as Record<string, unknown>;
  const presentationId = readAliasedArg<string>(rawParams, 'presentation_id', 'presentationId');
  const includeNotes = readAliasedArg<boolean>(rawParams, 'include_notes', 'includeNotes');
  return (params.email === undefined || typeof params.email === 'string') &&
    typeof presentationId === 'string' &&
    (includeNotes === undefined || typeof includeNotes === 'boolean');
}

export function assertListSlidesArgs(args: unknown): asserts args is ListSlidesArgs {
  if (!isListSlidesArgs(args)) {
    throw new Error('Invalid list slides parameters. Required: email, presentation_id');
  }
}

export function isGetSlideArgs(args: unknown): args is GetSlideArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<GetSlideArgs>;
  const rawParams = args as Record<string, unknown>;
  const presentationId = readAliasedArg<string>(rawParams, 'presentation_id', 'presentationId');
  const slideIndex = readAliasedArg<number>(rawParams, 'slide_index', 'slideIndex');
  const maxChars = readAliasedArg<number>(rawParams, 'max_chars', 'maxChars');
  const returnJson = readAliasedArg<boolean>(rawParams, 'return_json', 'returnJson');
  return (params.email === undefined || typeof params.email === 'string') &&
    typeof presentationId === 'string' &&
    (slideIndex === undefined || typeof slideIndex === 'number') &&
    (maxChars === undefined || typeof maxChars === 'number') &&
    (returnJson === undefined || typeof returnJson === 'boolean');
}

export function assertGetSlideArgs(args: unknown): asserts args is GetSlideArgs {
  if (!isGetSlideArgs(args)) {
    throw new Error('Invalid get slide parameters. Required: email, presentation_id');
  }
}

export function isExtractPresentationIdArgs(args: unknown): args is ExtractPresentationIdArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<ExtractPresentationIdArgs>;
  return typeof params.input === 'string';
}

export function assertExtractPresentationIdArgs(args: unknown): asserts args is ExtractPresentationIdArgs {
  if (!isExtractPresentationIdArgs(args)) {
    throw new Error('Invalid extract presentation ID parameters. Required: input');
  }
}

// Sheets Type Guards
interface ReadSpreadsheetArgs {
  email: string;
  spreadsheetId: string;
  range?: string;
  maxRows?: number;
  maxCols?: number;
  returnJson?: boolean;
  value_view?: 'formatted' | 'shaped' | 'formula' | 'unformatted';
  valueView?: 'formatted' | 'shaped' | 'formula' | 'unformatted';
  anchor_mode?: 'auto' | 'always' | 'never';
  anchorMode?: 'auto' | 'always' | 'never';
  continuation_token?: string;
  continuationToken?: string;
}

interface ReadSpreadsheetValuesArgs {
  email: string;
  spreadsheetId: string;
  range: string;
  majorDimension?: 'ROWS' | 'COLUMNS';
  returnJson?: boolean;
  value_view?: 'formatted' | 'shaped' | 'formula' | 'unformatted';
  valueView?: 'formatted' | 'shaped' | 'formula' | 'unformatted';
  anchor_mode?: 'auto' | 'always' | 'never';
  anchorMode?: 'auto' | 'always' | 'never';
  continuation_token?: string;
  continuationToken?: string;
}

interface CreateSpreadsheetArgs {
  email: string;
  title: string;
  sheetTitles?: string[];
}

interface AppendSpreadsheetArgs {
  email: string;
  spreadsheetId: string;
  range: string;
  values: unknown[][];
  valueInputOption?: 'RAW' | 'USER_ENTERED';
  overwrite_formulas?: boolean;
  overwriteFormulas?: boolean;
}

interface UpdateSpreadsheetValuesArgs {
  email: string;
  spreadsheetId: string;
  range: string;
  values: unknown[][];
  valueInputOption?: 'RAW' | 'USER_ENTERED';
  overwrite_formulas?: boolean;
  overwriteFormulas?: boolean;
}

interface ClearSpreadsheetValuesArgs {
  email: string;
  spreadsheetId: string;
  range: string;
}

interface ListSpreadsheetSheetsArgs {
  email: string;
  spreadsheetId: string;
}

interface AddSpreadsheetSheetArgs {
  email: string;
  spreadsheetId: string;
  title: string;
  rowCount?: number;
  columnCount?: number;
}

interface DeleteSpreadsheetSheetArgs {
  email: string;
  spreadsheetId: string;
  sheetId: number;
}

interface ExtractSpreadsheetIdArgs {
  input: string;
}

export function isReadSpreadsheetArgs(args: unknown): args is ReadSpreadsheetArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<ReadSpreadsheetArgs>;
  const rawParams = args as Record<string, unknown>;
  const spreadsheetId = readAliasedArg<string>(rawParams, 'spreadsheet_id', 'spreadsheetId');
  const maxRows = readAliasedArg<number>(rawParams, 'max_rows', 'maxRows');
  const maxCols = readAliasedArg<number>(rawParams, 'max_cols', 'maxCols');
  const returnJson = readAliasedArg<boolean>(rawParams, 'return_json', 'returnJson');
  const valueView = readAliasedArg<'formatted' | 'shaped' | 'formula' | 'unformatted'>(rawParams, 'value_view', 'valueView');
  const anchorMode = readAliasedArg<'auto' | 'always' | 'never'>(rawParams, 'anchor_mode', 'anchorMode');
  const continuationToken = readAliasedArg<string>(rawParams, 'continuation_token', 'continuationToken');
  return (params.email === undefined || typeof params.email === 'string') &&
    typeof spreadsheetId === 'string' &&
    (params.range === undefined || typeof params.range === 'string') &&
    (maxRows === undefined || typeof maxRows === 'number') &&
    (maxCols === undefined || typeof maxCols === 'number') &&
    (returnJson === undefined || typeof returnJson === 'boolean') &&
    (valueView === undefined || ['formatted', 'shaped', 'formula', 'unformatted'].includes(valueView)) &&
    (anchorMode === undefined || ['auto', 'always', 'never'].includes(anchorMode)) &&
    (continuationToken === undefined || typeof continuationToken === 'string');
}

export function assertReadSpreadsheetArgs(args: unknown): asserts args is ReadSpreadsheetArgs {
  if (!isReadSpreadsheetArgs(args)) {
    throw new Error('Invalid read spreadsheet parameters. Required: email, spreadsheet_id');
  }
}

export function isReadSpreadsheetValuesArgs(args: unknown): args is ReadSpreadsheetValuesArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<ReadSpreadsheetValuesArgs>;
  const rawParams = args as Record<string, unknown>;
  const spreadsheetId = readAliasedArg<string>(rawParams, 'spreadsheet_id', 'spreadsheetId');
  const majorDimension = readAliasedArg<'ROWS' | 'COLUMNS'>(rawParams, 'major_dimension', 'majorDimension');
  const returnJson = readAliasedArg<boolean>(rawParams, 'return_json', 'returnJson');
  const valueView = readAliasedArg<'formatted' | 'shaped' | 'formula' | 'unformatted'>(rawParams, 'value_view', 'valueView');
  const anchorMode = readAliasedArg<'auto' | 'always' | 'never'>(rawParams, 'anchor_mode', 'anchorMode');
  const continuationToken = readAliasedArg<string>(rawParams, 'continuation_token', 'continuationToken');
  return (params.email === undefined || typeof params.email === 'string') &&
    typeof spreadsheetId === 'string' &&
    typeof params.range === 'string' &&
    (majorDimension === undefined || majorDimension === 'ROWS' || majorDimension === 'COLUMNS') &&
    (returnJson === undefined || typeof returnJson === 'boolean') &&
    (valueView === undefined || ['formatted', 'shaped', 'formula', 'unformatted'].includes(valueView)) &&
    (anchorMode === undefined || ['auto', 'always', 'never'].includes(anchorMode)) &&
    (continuationToken === undefined || typeof continuationToken === 'string');
}

export function assertReadSpreadsheetValuesArgs(args: unknown): asserts args is ReadSpreadsheetValuesArgs {
  if (!isReadSpreadsheetValuesArgs(args)) {
    throw new Error('Invalid read spreadsheet values parameters. Required: email, spreadsheet_id, range');
  }
}

export function isCreateSpreadsheetArgs(args: unknown): args is CreateSpreadsheetArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<CreateSpreadsheetArgs>;
  const sheetTitles = readAliasedArg<string[]>(args as Record<string, unknown>, 'sheet_titles', 'sheetTitles');
  return (params.email === undefined || typeof params.email === 'string') &&
    typeof params.title === 'string' &&
    (sheetTitles === undefined || (Array.isArray(sheetTitles) && sheetTitles.every(t => typeof t === 'string')));
}

export function assertCreateSpreadsheetArgs(args: unknown): asserts args is CreateSpreadsheetArgs {
  if (!isCreateSpreadsheetArgs(args)) {
    throw new Error('Invalid create spreadsheet parameters. Required: email, title');
  }
}

export function isAppendSpreadsheetArgs(args: unknown): args is AppendSpreadsheetArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<AppendSpreadsheetArgs>;
  const rawParams = args as Record<string, unknown>;
  const spreadsheetId = readAliasedArg<string>(rawParams, 'spreadsheet_id', 'spreadsheetId');
  const valueInputOption = readAliasedArg<'RAW' | 'USER_ENTERED'>(rawParams, 'value_input_option', 'valueInputOption');
  const overwriteFormulas = readAliasedArg<boolean>(rawParams, 'overwrite_formulas', 'overwriteFormulas');
  return (params.email === undefined || typeof params.email === 'string') &&
    typeof spreadsheetId === 'string' &&
    typeof params.range === 'string' &&
    Array.isArray(params.values) &&
    params.values.every(row => Array.isArray(row)) &&
    (valueInputOption === undefined || valueInputOption === 'RAW' || valueInputOption === 'USER_ENTERED') &&
    (overwriteFormulas === undefined || typeof overwriteFormulas === 'boolean');
}

export function assertAppendSpreadsheetArgs(args: unknown): asserts args is AppendSpreadsheetArgs {
  if (!isAppendSpreadsheetArgs(args)) {
    throw new Error('Invalid append spreadsheet parameters. Required: email, spreadsheet_id, range, values');
  }
}

export function isUpdateSpreadsheetValuesArgs(args: unknown): args is UpdateSpreadsheetValuesArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<UpdateSpreadsheetValuesArgs>;
  const rawParams = args as Record<string, unknown>;
  const spreadsheetId = readAliasedArg<string>(rawParams, 'spreadsheet_id', 'spreadsheetId');
  const valueInputOption = readAliasedArg<'RAW' | 'USER_ENTERED'>(rawParams, 'value_input_option', 'valueInputOption');
  const overwriteFormulas = readAliasedArg<boolean>(rawParams, 'overwrite_formulas', 'overwriteFormulas');
  return (params.email === undefined || typeof params.email === 'string') &&
    typeof spreadsheetId === 'string' &&
    typeof params.range === 'string' &&
    Array.isArray(params.values) &&
    params.values.every(row => Array.isArray(row)) &&
    (valueInputOption === undefined || valueInputOption === 'RAW' || valueInputOption === 'USER_ENTERED') &&
    (overwriteFormulas === undefined || typeof overwriteFormulas === 'boolean');
}

export function assertUpdateSpreadsheetValuesArgs(args: unknown): asserts args is UpdateSpreadsheetValuesArgs {
  if (!isUpdateSpreadsheetValuesArgs(args)) {
    throw new Error('Invalid update spreadsheet values parameters. Required: email, spreadsheet_id, range, values');
  }
}

export function isClearSpreadsheetValuesArgs(args: unknown): args is ClearSpreadsheetValuesArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<ClearSpreadsheetValuesArgs>;
  const spreadsheetId = readAliasedArg<string>(args as Record<string, unknown>, 'spreadsheet_id', 'spreadsheetId');
  return (params.email === undefined || typeof params.email === 'string') &&
    typeof spreadsheetId === 'string' &&
    typeof params.range === 'string';
}

export function assertClearSpreadsheetValuesArgs(args: unknown): asserts args is ClearSpreadsheetValuesArgs {
  if (!isClearSpreadsheetValuesArgs(args)) {
    throw new Error('Invalid clear spreadsheet values parameters. Required: email, spreadsheet_id, range');
  }
}

export function isListSpreadsheetSheetsArgs(args: unknown): args is ListSpreadsheetSheetsArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<ListSpreadsheetSheetsArgs>;
  const spreadsheetId = readAliasedArg<string>(args as Record<string, unknown>, 'spreadsheet_id', 'spreadsheetId');
  return (params.email === undefined || typeof params.email === 'string') &&
    typeof spreadsheetId === 'string';
}

export function assertListSpreadsheetSheetsArgs(args: unknown): asserts args is ListSpreadsheetSheetsArgs {
  if (!isListSpreadsheetSheetsArgs(args)) {
    throw new Error('Invalid list spreadsheet sheets parameters. Required: email, spreadsheet_id');
  }
}

export function isAddSpreadsheetSheetArgs(args: unknown): args is AddSpreadsheetSheetArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<AddSpreadsheetSheetArgs>;
  const rawParams = args as Record<string, unknown>;
  const spreadsheetId = readAliasedArg<string>(rawParams, 'spreadsheet_id', 'spreadsheetId');
  const rowCount = readAliasedArg<number>(rawParams, 'row_count', 'rowCount');
  const columnCount = readAliasedArg<number>(rawParams, 'column_count', 'columnCount');
  return (params.email === undefined || typeof params.email === 'string') &&
    typeof spreadsheetId === 'string' &&
    typeof params.title === 'string' &&
    (rowCount === undefined || typeof rowCount === 'number') &&
    (columnCount === undefined || typeof columnCount === 'number');
}

export function assertAddSpreadsheetSheetArgs(args: unknown): asserts args is AddSpreadsheetSheetArgs {
  if (!isAddSpreadsheetSheetArgs(args)) {
    throw new Error('Invalid add spreadsheet sheet parameters. Required: email, spreadsheet_id, title');
  }
}

export function isDeleteSpreadsheetSheetArgs(args: unknown): args is DeleteSpreadsheetSheetArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<DeleteSpreadsheetSheetArgs>;
  const rawParams = args as Record<string, unknown>;
  const spreadsheetId = readAliasedArg<string>(rawParams, 'spreadsheet_id', 'spreadsheetId');
  const sheetId = readAliasedArg<number>(rawParams, 'sheet_id', 'sheetId');
  return (params.email === undefined || typeof params.email === 'string') &&
    typeof spreadsheetId === 'string' &&
    typeof sheetId === 'number';
}

export function assertDeleteSpreadsheetSheetArgs(args: unknown): asserts args is DeleteSpreadsheetSheetArgs {
  if (!isDeleteSpreadsheetSheetArgs(args)) {
    throw new Error('Invalid delete spreadsheet sheet parameters. Required: email, spreadsheet_id, sheet_id');
  }
}

export function isExtractSpreadsheetIdArgs(args: unknown): args is ExtractSpreadsheetIdArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<ExtractSpreadsheetIdArgs>;
  return typeof params.input === 'string';
}

export function assertExtractSpreadsheetIdArgs(args: unknown): asserts args is ExtractSpreadsheetIdArgs {
  if (!isExtractSpreadsheetIdArgs(args)) {
    throw new Error('Invalid extract spreadsheet ID parameters. Required: input');
  }
}

// Batch and Advanced Sheets Operations

interface BatchGetSpreadsheetValuesArgs {
  email: string;
  spreadsheetId: string;
  ranges: string[];
  majorDimension?: 'ROWS' | 'COLUMNS';
  returnJson?: boolean;
  value_view?: 'formatted' | 'shaped' | 'formula' | 'unformatted';
  valueView?: 'formatted' | 'shaped' | 'formula' | 'unformatted';
  anchor_mode?: 'auto' | 'always' | 'never';
  anchorMode?: 'auto' | 'always' | 'never';
  continuation_token?: string;
  continuationToken?: string;
}

interface BatchUpdateSpreadsheetValuesArgs {
  email: string;
  spreadsheetId: string;
  data: { range: string; values: unknown[][] }[];
  valueInputOption?: 'RAW' | 'USER_ENTERED';
  overwrite_formulas?: boolean;
  overwriteFormulas?: boolean;
}

interface FindReplaceSpreadsheetArgs {
  email: string;
  spreadsheetId: string;
  find: string;
  replacement: string;
  sheetId?: number;
  matchCase?: boolean;
  matchEntireCell?: boolean;
  searchByRegex?: boolean;
  includeFormulas?: boolean;
}

interface CellColor {
  red?: number;
  green?: number;
  blue?: number;
  alpha?: number;
}

interface FormatSpreadsheetCellsArgs {
  email: string;
  spreadsheetId: string;
  sheetId: number;
  startRowIndex: number;
  endRowIndex: number;
  startColumnIndex: number;
  endColumnIndex: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  fontSize?: number;
  textColor?: CellColor;
  backgroundColor?: CellColor;
  borderStyle?: string;
  borderColor?: CellColor;
}

export function isBatchGetSpreadsheetValuesArgs(args: unknown): args is BatchGetSpreadsheetValuesArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<BatchGetSpreadsheetValuesArgs>;
  const rawParams = args as Record<string, unknown>;
  const spreadsheetId = readAliasedArg<string>(rawParams, 'spreadsheet_id', 'spreadsheetId');
  const majorDimension = readAliasedArg<'ROWS' | 'COLUMNS'>(rawParams, 'major_dimension', 'majorDimension');
  const returnJson = readAliasedArg<boolean>(rawParams, 'return_json', 'returnJson');
  const valueView = readAliasedArg<'formatted' | 'shaped' | 'formula' | 'unformatted'>(rawParams, 'value_view', 'valueView');
  const anchorMode = readAliasedArg<'auto' | 'always' | 'never'>(rawParams, 'anchor_mode', 'anchorMode');
  const continuationToken = readAliasedArg<string>(rawParams, 'continuation_token', 'continuationToken');
  return (params.email === undefined || typeof params.email === 'string') &&
    typeof spreadsheetId === 'string' &&
    Array.isArray(params.ranges) &&
    params.ranges.every(r => typeof r === 'string') &&
    (majorDimension === undefined || majorDimension === 'ROWS' || majorDimension === 'COLUMNS') &&
    (returnJson === undefined || typeof returnJson === 'boolean') &&
    (valueView === undefined || ['formatted', 'shaped', 'formula', 'unformatted'].includes(valueView)) &&
    (anchorMode === undefined || ['auto', 'always', 'never'].includes(anchorMode)) &&
    (continuationToken === undefined || typeof continuationToken === 'string');
}

export function assertBatchGetSpreadsheetValuesArgs(args: unknown): asserts args is BatchGetSpreadsheetValuesArgs {
  if (!isBatchGetSpreadsheetValuesArgs(args)) {
    throw new Error('Invalid batch get spreadsheet values parameters. Required: email, spreadsheet_id, ranges (array of strings)');
  }
}

export function isBatchUpdateSpreadsheetValuesArgs(args: unknown): args is BatchUpdateSpreadsheetValuesArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<BatchUpdateSpreadsheetValuesArgs>;
  const rawParams = args as Record<string, unknown>;
  const spreadsheetId = readAliasedArg<string>(rawParams, 'spreadsheet_id', 'spreadsheetId');
  const valueInputOption = readAliasedArg<'RAW' | 'USER_ENTERED'>(rawParams, 'value_input_option', 'valueInputOption');
  const overwriteFormulas = readAliasedArg<boolean>(rawParams, 'overwrite_formulas', 'overwriteFormulas');
  return (params.email === undefined || typeof params.email === 'string') &&
    typeof spreadsheetId === 'string' &&
    Array.isArray(params.data) &&
    params.data.every(d => {
      if (typeof d !== 'object' || d === null) return false;
      const item = d as { range: unknown; values: unknown };
      if (typeof item.range !== 'string') return false;
      if (!Array.isArray(item.values)) return false;
      // Validate that values is a 2D array (each row must be an array)
      return item.values.every(row => Array.isArray(row));
    }) &&
    (valueInputOption === undefined || valueInputOption === 'RAW' || valueInputOption === 'USER_ENTERED') &&
    (overwriteFormulas === undefined || typeof overwriteFormulas === 'boolean');
}

export function assertBatchUpdateSpreadsheetValuesArgs(args: unknown): asserts args is BatchUpdateSpreadsheetValuesArgs {
  if (!isBatchUpdateSpreadsheetValuesArgs(args)) {
    throw new Error('Invalid batch update spreadsheet values parameters. Required: email, spreadsheet_id, data (array of {range, values})');
  }
}

export function isFindReplaceSpreadsheetArgs(args: unknown): args is FindReplaceSpreadsheetArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<FindReplaceSpreadsheetArgs>;
  const rawParams = args as Record<string, unknown>;
  const spreadsheetId = readAliasedArg<string>(rawParams, 'spreadsheet_id', 'spreadsheetId');
  const sheetId = readAliasedArg<number>(rawParams, 'sheet_id', 'sheetId');
  const matchCase = readAliasedArg<boolean>(rawParams, 'match_case', 'matchCase');
  const matchEntireCell = readAliasedArg<boolean>(rawParams, 'match_entire_cell', 'matchEntireCell');
  const searchByRegex = readAliasedArg<boolean>(rawParams, 'search_by_regex', 'searchByRegex');
  const includeFormulas = readAliasedArg<boolean>(rawParams, 'include_formulas', 'includeFormulas');
  return (params.email === undefined || typeof params.email === 'string') &&
    typeof spreadsheetId === 'string' &&
    typeof params.find === 'string' &&
    typeof params.replacement === 'string' &&
    (sheetId === undefined || typeof sheetId === 'number') &&
    (matchCase === undefined || typeof matchCase === 'boolean') &&
    (matchEntireCell === undefined || typeof matchEntireCell === 'boolean') &&
    (searchByRegex === undefined || typeof searchByRegex === 'boolean') &&
    (includeFormulas === undefined || typeof includeFormulas === 'boolean');
}

export function assertFindReplaceSpreadsheetArgs(args: unknown): asserts args is FindReplaceSpreadsheetArgs {
  if (!isFindReplaceSpreadsheetArgs(args)) {
    throw new Error('Invalid find and replace parameters. Required: email, spreadsheet_id, find, replacement');
  }
}

function isValidCellColor(color: unknown): color is CellColor {
  if (typeof color !== 'object' || color === null) return false;
  const c = color as CellColor;
  return (c.red === undefined || typeof c.red === 'number') &&
    (c.green === undefined || typeof c.green === 'number') &&
    (c.blue === undefined || typeof c.blue === 'number') &&
    (c.alpha === undefined || typeof c.alpha === 'number');
}

export function isFormatSpreadsheetCellsArgs(args: unknown): args is FormatSpreadsheetCellsArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<FormatSpreadsheetCellsArgs>;
  const rawParams = args as Record<string, unknown>;
  const spreadsheetId = readAliasedArg<string>(rawParams, 'spreadsheet_id', 'spreadsheetId');
  const sheetId = readAliasedArg<number>(rawParams, 'sheet_id', 'sheetId');
  const startRowIndex = readAliasedArg<number>(rawParams, 'start_row_index', 'startRowIndex');
  const endRowIndex = readAliasedArg<number>(rawParams, 'end_row_index', 'endRowIndex');
  const startColumnIndex = readAliasedArg<number>(rawParams, 'start_column_index', 'startColumnIndex');
  const endColumnIndex = readAliasedArg<number>(rawParams, 'end_column_index', 'endColumnIndex');
  const fontSize = readAliasedArg<number>(rawParams, 'font_size', 'fontSize');
  const textColor = readAliasedArg<unknown>(rawParams, 'text_color', 'textColor');
  const backgroundColor = readAliasedArg<unknown>(rawParams, 'background_color', 'backgroundColor');
  const borderStyle = readAliasedArg<string>(rawParams, 'border_style', 'borderStyle');
  const borderColor = readAliasedArg<unknown>(rawParams, 'border_color', 'borderColor');
  return (params.email === undefined || typeof params.email === 'string') &&
    typeof spreadsheetId === 'string' &&
    typeof sheetId === 'number' &&
    typeof startRowIndex === 'number' &&
    typeof endRowIndex === 'number' &&
    typeof startColumnIndex === 'number' &&
    typeof endColumnIndex === 'number' &&
    (params.bold === undefined || typeof params.bold === 'boolean') &&
    (params.italic === undefined || typeof params.italic === 'boolean') &&
    (params.underline === undefined || typeof params.underline === 'boolean') &&
    (params.strikethrough === undefined || typeof params.strikethrough === 'boolean') &&
    (fontSize === undefined || typeof fontSize === 'number') &&
    (textColor === undefined || isValidCellColor(textColor)) &&
    (backgroundColor === undefined || isValidCellColor(backgroundColor)) &&
    (borderStyle === undefined || typeof borderStyle === 'string') &&
    (borderColor === undefined || isValidCellColor(borderColor));
}

export function assertFormatSpreadsheetCellsArgs(args: unknown): asserts args is FormatSpreadsheetCellsArgs {
  if (!isFormatSpreadsheetCellsArgs(args)) {
    throw new Error('Invalid format cells parameters. Required: email, spreadsheet_id, sheet_id, start_row_index, end_row_index, start_column_index, end_column_index');
  }
}

// Slides Batch Update and Thumbnail Type Guards

interface BatchUpdatePresentationArgs {
  email: string;
  presentationId: string;
  requests: object[];
  writeControl?: {
    requiredRevisionId?: string;
  };
  returnJson?: boolean;
}

interface GetSlideThumbnailArgs {
  email: string;
  presentationId: string;
  slideId: string;
  thumbnailSize?: 'SMALL' | 'MEDIUM' | 'LARGE';
}

export function isBatchUpdatePresentationArgs(args: unknown): args is BatchUpdatePresentationArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<BatchUpdatePresentationArgs>;
  const rawParams = args as Record<string, unknown>;
  const presentationId = readAliasedArg<string>(rawParams, 'presentation_id', 'presentationId');
  const writeControl = readAliasedArg<Record<string, unknown>>(rawParams, 'write_control', 'writeControl');
  const returnJson = readAliasedArg<boolean>(rawParams, 'return_json', 'returnJson');
  
  // Required fields
  if (params.email !== undefined && typeof params.email !== 'string') return false;
  if (typeof presentationId !== 'string') return false;
  
  // requests must be a non-empty array of objects
  if (!Array.isArray(params.requests) || params.requests.length === 0) return false;
  if (!params.requests.every(r => typeof r === 'object' && r !== null)) return false;
  
  // Optional writeControl validation
  if (writeControl !== undefined) {
    if (typeof writeControl !== 'object' || writeControl === null) return false;
    const wc = writeControl as { requiredRevisionId?: unknown };
    if (wc.requiredRevisionId !== undefined && typeof wc.requiredRevisionId !== 'string') return false;
  }
  
  // Optional returnJson validation
  if (returnJson !== undefined && typeof returnJson !== 'boolean') return false;
  
  return true;
}

export function assertBatchUpdatePresentationArgs(args: unknown): asserts args is BatchUpdatePresentationArgs {
  if (!isBatchUpdatePresentationArgs(args)) {
    throw new Error('Invalid batch update presentation parameters. Required: presentation_id, requests (non-empty array of objects)');
  }
}

export function isGetSlideThumbnailArgs(args: unknown): args is GetSlideThumbnailArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<GetSlideThumbnailArgs>;
  const rawParams = args as Record<string, unknown>;
  const presentationId = readAliasedArg<string>(rawParams, 'presentation_id', 'presentationId');
  const slideId = readAliasedArg<string>(rawParams, 'slide_id', 'slideId');
  const thumbnailSize = readAliasedArg<string>(rawParams, 'thumbnail_size', 'thumbnailSize');
  
  // Required fields
  if (params.email !== undefined && typeof params.email !== 'string') return false;
  if (typeof presentationId !== 'string') return false;
  if (typeof slideId !== 'string') return false;
  
  // Optional thumbnailSize validation
  if (thumbnailSize !== undefined) {
    if (!['SMALL', 'MEDIUM', 'LARGE'].includes(thumbnailSize)) return false;
  }
  
  return true;
}

export function assertGetSlideThumbnailArgs(args: unknown): asserts args is GetSlideThumbnailArgs {
  if (!isGetSlideThumbnailArgs(args)) {
    throw new Error('Invalid get slide thumbnail parameters. Required: presentation_id, slide_id');
  }
}

// ============================================================================
// Google Tasks Type Guards
// ============================================================================

interface ListTaskListsArgs {
  email?: string;
}

interface ListTasksArgs {
  email?: string;
  taskListId?: string;
  maxResults?: number;
  pageToken?: string;
  showCompleted?: boolean;
  showHidden?: boolean;
  dueMin?: string;
  dueMax?: string;
}

interface CreateTaskArgs {
  email?: string;
  taskListId?: string;
  title: string;
  notes?: string;
  due?: string;
}

interface UpdateTaskArgs {
  email?: string;
  taskListId?: string;
  taskId: string;
  title?: string;
  notes?: string;
  due?: string;
  status?: 'needsAction' | 'completed';
}

interface CompleteTaskArgs {
  email?: string;
  taskListId?: string;
  taskId: string;
}

interface DeleteTaskArgs {
  email?: string;
  taskListId?: string;
  taskId: string;
}

export function isListTaskListsArgs(args: unknown): args is ListTaskListsArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<ListTaskListsArgs>;
  return params.email === undefined || typeof params.email === 'string';
}

export function assertListTaskListsArgs(args: unknown): asserts args is ListTaskListsArgs {
  if (!isListTaskListsArgs(args)) {
    throw new Error('Invalid list task lists parameters. email must be a string or undefined.');
  }
}

export function isListTasksArgs(args: unknown): args is ListTasksArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<ListTasksArgs>;
  const rawParams = args as Record<string, unknown>;
  const taskListId = readAliasedArg<string>(rawParams, 'task_list_id', 'taskListId');
  const maxResults = readAliasedArg<number>(rawParams, 'max_results', 'maxResults');
  const pageToken = readAliasedArg<string>(rawParams, 'page_token', 'pageToken');
  const showCompleted = readAliasedArg<boolean>(rawParams, 'show_completed', 'showCompleted');
  const showHidden = readAliasedArg<boolean>(rawParams, 'show_hidden', 'showHidden');
  const dueMin = readAliasedArg<string>(rawParams, 'due_min', 'dueMin');
  const dueMax = readAliasedArg<string>(rawParams, 'due_max', 'dueMax');
  return (params.email === undefined || typeof params.email === 'string') &&
    (taskListId === undefined || typeof taskListId === 'string') &&
    (maxResults === undefined || typeof maxResults === 'number') &&
    (pageToken === undefined || typeof pageToken === 'string') &&
    (showCompleted === undefined || typeof showCompleted === 'boolean') &&
    (showHidden === undefined || typeof showHidden === 'boolean') &&
    (dueMin === undefined || typeof dueMin === 'string') &&
    (dueMax === undefined || typeof dueMax === 'string');
}

export function assertListTasksArgs(args: unknown): asserts args is ListTasksArgs {
  if (!isListTasksArgs(args)) {
    throw new Error('Invalid list tasks parameters. Check parameter types.');
  }
}

export function isCreateTaskArgs(args: unknown): args is CreateTaskArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<CreateTaskArgs>;
  const taskListId = readAliasedArg<string>(args as Record<string, unknown>, 'task_list_id', 'taskListId');
  return (params.email === undefined || typeof params.email === 'string') &&
    (taskListId === undefined || typeof taskListId === 'string') &&
    typeof params.title === 'string' &&
    (params.notes === undefined || typeof params.notes === 'string') &&
    (params.due === undefined || typeof params.due === 'string');
}

export function assertCreateTaskArgs(args: unknown): asserts args is CreateTaskArgs {
  if (!isCreateTaskArgs(args)) {
    throw new Error('Invalid create task parameters. Required: title (string).');
  }
}

export function isUpdateTaskArgs(args: unknown): args is UpdateTaskArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<UpdateTaskArgs>;
  const rawParams = args as Record<string, unknown>;
  const taskListId = readAliasedArg<string>(rawParams, 'task_list_id', 'taskListId');
  const taskId = readAliasedArg<string>(rawParams, 'task_id', 'taskId');
  return (params.email === undefined || typeof params.email === 'string') &&
    (taskListId === undefined || typeof taskListId === 'string') &&
    typeof taskId === 'string' &&
    (params.title === undefined || typeof params.title === 'string') &&
    (params.notes === undefined || typeof params.notes === 'string') &&
    (params.due === undefined || typeof params.due === 'string') &&
    (params.status === undefined || params.status === 'needsAction' || params.status === 'completed');
}

export function assertUpdateTaskArgs(args: unknown): asserts args is UpdateTaskArgs {
  if (!isUpdateTaskArgs(args)) {
    throw new Error('Invalid update task parameters. Required: task_id (string). Optional: title, notes, due, status.');
  }
}

export function isCompleteTaskArgs(args: unknown): args is CompleteTaskArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<CompleteTaskArgs>;
  const rawParams = args as Record<string, unknown>;
  const taskListId = readAliasedArg<string>(rawParams, 'task_list_id', 'taskListId');
  const taskId = readAliasedArg<string>(rawParams, 'task_id', 'taskId');
  return (params.email === undefined || typeof params.email === 'string') &&
    (taskListId === undefined || typeof taskListId === 'string') &&
    typeof taskId === 'string';
}

export function assertCompleteTaskArgs(args: unknown): asserts args is CompleteTaskArgs {
  if (!isCompleteTaskArgs(args)) {
    throw new Error('Invalid complete task parameters. Required: task_id (string).');
  }
}

export function isDeleteTaskArgs(args: unknown): args is DeleteTaskArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<DeleteTaskArgs>;
  const rawParams = args as Record<string, unknown>;
  const taskListId = readAliasedArg<string>(rawParams, 'task_list_id', 'taskListId');
  const taskId = readAliasedArg<string>(rawParams, 'task_id', 'taskId');
  return (params.email === undefined || typeof params.email === 'string') &&
    (taskListId === undefined || typeof taskListId === 'string') &&
    typeof taskId === 'string';
}

export function assertDeleteTaskArgs(args: unknown): asserts args is DeleteTaskArgs {
  if (!isDeleteTaskArgs(args)) {
    throw new Error('Invalid delete task parameters. Required: task_id (string).');
  }
}

// ============================================================================
// Google Forms Type Guards
// ============================================================================

interface ListFormsArgs {
  email?: string;
  maxResults?: number;
  query?: string;
}

interface GetFormArgs {
  email?: string;
  formId: string;
}

interface ListFormResponsesArgs {
  email?: string;
  formId: string;
  maxResults?: number;
  pageToken?: string;
}

interface GetFormResponseArgs {
  email?: string;
  formId: string;
  responseId: string;
}

export function isListFormsArgs(args: unknown): args is ListFormsArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<ListFormsArgs>;
  const maxResults = readAliasedArg<number>(args as Record<string, unknown>, 'max_results', 'maxResults');
  return (params.email === undefined || typeof params.email === 'string') &&
    (maxResults === undefined || typeof maxResults === 'number') &&
    (params.query === undefined || typeof params.query === 'string');
}

export function assertListFormsArgs(args: unknown): asserts args is ListFormsArgs {
  if (!isListFormsArgs(args)) {
    throw new Error('Invalid list forms parameters. Optional: email, max_results, query.');
  }
}

export function isGetFormArgs(args: unknown): args is GetFormArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<GetFormArgs>;
  const formId = readAliasedArg<string>(args as Record<string, unknown>, 'form_id', 'formId');
  return (params.email === undefined || typeof params.email === 'string') &&
    typeof formId === 'string';
}

export function assertGetFormArgs(args: unknown): asserts args is GetFormArgs {
  if (!isGetFormArgs(args)) {
    throw new Error('Invalid get form parameters. Required: form_id (string).');
  }
}

export function isListFormResponsesArgs(args: unknown): args is ListFormResponsesArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<ListFormResponsesArgs>;
  const rawParams = args as Record<string, unknown>;
  const formId = readAliasedArg<string>(rawParams, 'form_id', 'formId');
  const maxResults = readAliasedArg<number>(rawParams, 'max_results', 'maxResults');
  const pageToken = readAliasedArg<string>(rawParams, 'page_token', 'pageToken');
  return (params.email === undefined || typeof params.email === 'string') &&
    typeof formId === 'string' &&
    (maxResults === undefined || typeof maxResults === 'number') &&
    (pageToken === undefined || typeof pageToken === 'string');
}

export function assertListFormResponsesArgs(args: unknown): asserts args is ListFormResponsesArgs {
  if (!isListFormResponsesArgs(args)) {
    throw new Error('Invalid list form responses parameters. Required: form_id (string). Optional: max_results, page_token.');
  }
}

export function isGetFormResponseArgs(args: unknown): args is GetFormResponseArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<GetFormResponseArgs>;
  const rawParams = args as Record<string, unknown>;
  const formId = readAliasedArg<string>(rawParams, 'form_id', 'formId');
  const responseId = readAliasedArg<string>(rawParams, 'response_id', 'responseId');
  return (params.email === undefined || typeof params.email === 'string') &&
    typeof formId === 'string' &&
    typeof responseId === 'string';
}

export function assertGetFormResponseArgs(args: unknown): asserts args is GetFormResponseArgs {
  if (!isGetFormResponseArgs(args)) {
    throw new Error('Invalid get form response parameters. Required: form_id (string), response_id (string).');
  }
}

// Comments Type Guards

interface ListCommentsArgs {
  email?: string;
  fileId: string;
  pageSize?: number;
  pageToken?: string;
  includeDeleted?: boolean;
}

interface CreateCommentArgs {
  email?: string;
  fileId: string;
  content: string;
  anchor?: string;
  quotedFileContent?: { mimeType: string; value: string };
}

interface ResolveCommentArgs {
  email?: string;
  fileId: string;
  commentId: string;
  action: 'resolve' | 'reopen';
}

interface ReplyToCommentArgs {
  email?: string;
  fileId: string;
  commentId: string;
  content: string;
}

interface DeleteCommentArgs {
  email?: string;
  fileId: string;
  commentId: string;
}

export function isListCommentsArgs(args: unknown): args is ListCommentsArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<ListCommentsArgs>;
  const rawParams = args as Record<string, unknown>;
  const fileId = readAliasedArg<string>(rawParams, 'file_id', 'fileId');
  const pageSize = readAliasedArg<number>(rawParams, 'page_size', 'pageSize');
  const pageToken = readAliasedArg<string>(rawParams, 'page_token', 'pageToken');
  const includeDeleted = readAliasedArg<boolean>(rawParams, 'include_deleted', 'includeDeleted');
  return (params.email === undefined || typeof params.email === 'string') &&
    typeof fileId === 'string' &&
    (pageSize === undefined || typeof pageSize === 'number') &&
    (pageToken === undefined || typeof pageToken === 'string') &&
    (includeDeleted === undefined || typeof includeDeleted === 'boolean');
}

export function assertListCommentsArgs(args: unknown): asserts args is ListCommentsArgs {
  if (!isListCommentsArgs(args)) {
    throw new Error('Invalid list comments parameters. Required: file_id (string). Optional: page_size, page_token, include_deleted.');
  }
}

export function isCreateCommentArgs(args: unknown): args is CreateCommentArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<CreateCommentArgs>;
  const fileId = readAliasedArg<string>(args as Record<string, unknown>, 'file_id', 'fileId');
  return (params.email === undefined || typeof params.email === 'string') &&
    typeof fileId === 'string' &&
    typeof params.content === 'string';
}

export function assertCreateCommentArgs(args: unknown): asserts args is CreateCommentArgs {
  if (!isCreateCommentArgs(args)) {
    throw new Error('Invalid create comment parameters. Required: file_id (string), content (string).');
  }
}

export function isResolveCommentArgs(args: unknown): args is ResolveCommentArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<ResolveCommentArgs>;
  const rawParams = args as Record<string, unknown>;
  const fileId = readAliasedArg<string>(rawParams, 'file_id', 'fileId');
  const commentId = readAliasedArg<string>(rawParams, 'comment_id', 'commentId');
  return (params.email === undefined || typeof params.email === 'string') &&
    typeof fileId === 'string' &&
    typeof commentId === 'string' &&
    (params.action === 'resolve' || params.action === 'reopen');
}

export function assertResolveCommentArgs(args: unknown): asserts args is ResolveCommentArgs {
  if (!isResolveCommentArgs(args)) {
    throw new Error('Invalid resolve comment parameters. Required: file_id (string), comment_id (string), action ("resolve" | "reopen").');
  }
}

export function isReplyToCommentArgs(args: unknown): args is ReplyToCommentArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<ReplyToCommentArgs>;
  const rawParams = args as Record<string, unknown>;
  const fileId = readAliasedArg<string>(rawParams, 'file_id', 'fileId');
  const commentId = readAliasedArg<string>(rawParams, 'comment_id', 'commentId');
  return (params.email === undefined || typeof params.email === 'string') &&
    typeof fileId === 'string' &&
    typeof commentId === 'string' &&
    typeof params.content === 'string';
}

export function assertReplyToCommentArgs(args: unknown): asserts args is ReplyToCommentArgs {
  if (!isReplyToCommentArgs(args)) {
    throw new Error('Invalid reply to comment parameters. Required: file_id (string), comment_id (string), content (string).');
  }
}

export function isDeleteCommentArgs(args: unknown): args is DeleteCommentArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<DeleteCommentArgs>;
  const rawParams = args as Record<string, unknown>;
  const fileId = readAliasedArg<string>(rawParams, 'file_id', 'fileId');
  const commentId = readAliasedArg<string>(rawParams, 'comment_id', 'commentId');
  return (params.email === undefined || typeof params.email === 'string') &&
    typeof fileId === 'string' &&
    typeof commentId === 'string';
}

export function assertDeleteCommentArgs(args: unknown): asserts args is DeleteCommentArgs {
  if (!isDeleteCommentArgs(args)) {
    throw new Error('Invalid delete comment parameters. Required: file_id (string), comment_id (string).');
  }
}

// ============================================================================
// Gmail Quick Action Type Guards
// ============================================================================

interface GmailQuickActionArgs {
  email?: string;
  message_id?: string;
  messageId?: string;
  message_ids?: string[];
  messageIds?: string[];
}

export function isGmailQuickActionArgs(args: unknown): args is GmailQuickActionArgs {
  if (typeof args !== 'object' || args === null) return false;
  const params = args as Partial<GmailQuickActionArgs>;
  const rawParams = args as Record<string, unknown>;
  // email is optional
  if (params.email !== undefined && typeof params.email !== 'string') return false;
  // At least one of message_id/messageId or message_ids/messageIds must be present
  const messageId = readAliasedArg<string>(rawParams, 'message_id', 'messageId');
  const messageIds = readAliasedArg<unknown>(rawParams, 'message_ids', 'messageIds');
  const hasMessageId = typeof messageId === 'string';
  const hasMessageIds = Array.isArray(messageIds) && messageIds.every(id => typeof id === 'string');
  if (!hasMessageId && !hasMessageIds) return false;
  // If both provided, both must be valid
  if (messageId !== undefined && typeof messageId !== 'string') return false;
  if (messageIds !== undefined && !Array.isArray(messageIds)) return false;
  return true;
}

export function assertGmailQuickActionArgs(args: unknown): asserts args is GmailQuickActionArgs {
  if (!isGmailQuickActionArgs(args)) {
    throw new Error('Invalid Gmail quick action parameters. Required: message_id (string) or message_ids (string array).');
  }
}
