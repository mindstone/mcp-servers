import { unwrapUntrusted } from '../utils/untrusted-content.js';

const LEGACY_ALIASES: Record<string, string> = {
  hasAttachment: 'has_attachment',
  isUnread: 'is_unread',
  pageToken: 'page_token',
  includeBody: 'include_body',
  returnJson: 'return_json',
  threadId: 'thread_id',
  maxMessages: 'max_messages',
  messageId: 'message_id',
  messageIds: 'message_ids',
  isHtml: 'is_html',
  replyToMessageId: 'reply_to_message_id',
  draftId: 'draft_id',
  inReplyTo: 'in_reply_to',
  mimeType: 'mime_type',
  timeMin: 'time_min',
  timeMax: 'time_max',
  calendarId: 'calendar_id',
  eventId: 'event_id',
  colorId: 'color_id',
  sendUpdates: 'send_updates',
  deletionScope: 'deletion_scope',
  minSlotDurationMinutes: 'min_slot_duration_minutes',
  newTimes: 'new_times',
  maxResults: 'max_results',
  fileId: 'file_id',
  parentId: 'parent_id',
  newParentId: 'new_parent_id',
  removeFromParents: 'remove_from_parents',
  revisionId: 'revision_id',
  documentId: 'document_id',
  maxChars: 'max_chars',
  findText: 'find_text',
  replaceText: 'replace_text',
  matchCase: 'match_case',
  includeWordCount: 'include_word_count',
  tabId: 'tab_id',
  allTabs: 'all_tabs',
  parentTabId: 'parent_tab_id',
  anchorText: 'anchor_text',
  expectEmptyParagraph: 'expect_empty_paragraph',
  deleteSubTabs: 'delete_sub_tabs',
  sourceTabId: 'source_tab_id',
  targetTabId: 'target_tab_id',
  overwriteExisting: 'overwrite_existing',
  newTabTitle: 'new_tab_title',
  newTabParentId: 'new_tab_parent_id',
  newTabPosition: 'new_tab_position',
  writeControl: 'write_control',
  spreadsheetId: 'spreadsheet_id',
  maxRows: 'max_rows',
  maxCols: 'max_cols',
  majorDimension: 'major_dimension',
  valueView: 'value_view',
  anchorMode: 'anchor_mode',
  continuationToken: 'continuation_token',
  sheetTitles: 'sheet_titles',
  valueInputOption: 'value_input_option',
  overwriteFormulas: 'overwrite_formulas',
  sheetId: 'sheet_id',
  newTitle: 'new_title',
  sheetTitle: 'sheet_title',
  startIndex: 'start_index',
  inheritFrom: 'inherit_from',
  rowCount: 'row_count',
  columnCount: 'column_count',
  matchEntireCell: 'match_entire_cell',
  searchByRegex: 'search_by_regex',
  includeFormulas: 'include_formulas',
  startRowIndex: 'start_row_index',
  endRowIndex: 'end_row_index',
  startColumnIndex: 'start_column_index',
  endColumnIndex: 'end_column_index',
  fontSize: 'font_size',
  textColor: 'text_color',
  backgroundColor: 'background_color',
  borderStyle: 'border_style',
  borderColor: 'border_color',
  presentationId: 'presentation_id',
  includeNotes: 'include_notes',
  slideIndex: 'slide_index',
  slideId: 'slide_id',
  thumbnailSize: 'thumbnail_size',
  personFields: 'person_fields',
  pageSize: 'page_size',
  taskListId: 'task_list_id',
  showCompleted: 'show_completed',
  showHidden: 'show_hidden',
  dueMin: 'due_min',
  dueMax: 'due_max',
  taskId: 'task_id',
  formId: 'form_id',
  responseId: 'response_id',
  commentId: 'comment_id',
  includeDeleted: 'include_deleted',
  quotedFileContent: 'quoted_file_content',
  labelId: 'label_id',
  messageListVisibility: 'message_list_visibility',
  labelListVisibility: 'label_list_visibility',
  labelIds: 'label_ids',
  filterId: 'filter_id',
};

export function normalizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = unwrapIdArgs({ ...args });

  for (const [legacyKey, canonicalKey] of Object.entries(LEGACY_ALIASES)) {
    if (!(canonicalKey in normalized) && legacyKey in args) {
      normalized[canonicalKey] = normalized[legacyKey];
    }
  }

  return normalized;
}

/**
 * Argument names that carry an id the connector returns inside the
 * untrusted-content envelope, because an outsider can choose it (an event's
 * creator, a shared calendar's owner, a document's author). Docs batch-update
 * requests carry tab ids under the API's own names.
 */
const WRAPPED_ID_KEYS = new Set([
  'event_id', 'eventId', 'calendar_id', 'calendarId',
  'tab_id', 'tabId', 'parent_tab_id', 'parentTabId', 'source_tab_id', 'sourceTabId',
  'target_tab_id', 'targetTabId', 'new_tab_parent_id', 'newTabParentId', 'tabIds',
  // find_free_slots takes calendar ids (addresses) as attendees.
  'attendees',
]);

/**
 * Strip one envelope from every string under an id key, at any depth, so an id
 * copied with its envelope from an earlier result works; other text is untouched.
 */
export function unwrapIdArgs<T>(value: T, underIdKey = false): T {
  if (typeof value === 'string') return (underIdKey ? unwrapUntrusted(value) : value) as T;
  if (Array.isArray(value)) return value.map(item => unwrapIdArgs(item, underIdKey)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key, unwrapIdArgs(item, WRAPPED_ID_KEYS.has(key))])) as T;
  }
  return value;
}
