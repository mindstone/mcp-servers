import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.ENABLE_GOOGLE_TASKS_FORMS = 'true';

const { allTools } = await import(pathToFileURL(path.join(root, 'dist/tools/definitions/index.js')).href);

const serverSource = fs.readFileSync(path.join(root, 'src/tools/server.ts'), 'utf8');

const handlerModuleByName = new Map();
for (const match of serverSource.matchAll(/import\s*{([\s\S]*?)}\s*from\s*'([^']+)'/g)) {
  const importedNames = match[1]
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const modulePath = match[2];
  for (const importedName of importedNames) {
    handlerModuleByName.set(importedName, modulePath.replace(/^\.\//, 'src/tools/').replace(/\.js$/, '.ts'));
  }
}

const handlerByTool = new Map();
for (const match of serverSource.matchAll(/case '([^']+)':([\s\S]*?)(?:break;|return)/g)) {
  const tool = match[1];
  const body = match[2];
  const handler = body.match(/result\s*=\s*await\s+(handle[A-Za-z0-9_]+)/)?.[1];
  if (handler) {
    handlerByTool.set(tool, handler);
  }
}

const endpointOverrides = new Map(Object.entries({
  list_workspace_accounts: ['local', 'LOCAL', 'local://accounts'],
  authenticate_workspace_account: ['local', 'LOCAL', 'local://auth-required'],
  remove_workspace_account: ['local', 'LOCAL', 'local://accounts/{email}'],

  search_workspace_emails: ['gmail', 'GET', 'https://gmail.googleapis.com/gmail/v1/users/{userId}/messages'],
  get_workspace_email_thread: ['gmail', 'GET', 'https://gmail.googleapis.com/gmail/v1/users/{userId}/threads/{id}'],
  compose_workspace_email: ['local', 'LOCAL', 'local://compose-email-ui'],
  send_workspace_email: ['gmail', 'POST', 'https://gmail.googleapis.com/gmail/v1/users/{userId}/messages/send'],
  get_workspace_gmail_settings: ['gmail', 'GET', 'https://gmail.googleapis.com/gmail/v1/users/{userId}/settings/*'],
  manage_workspace_draft: ['gmail', 'POST', 'https://gmail.googleapis.com/gmail/v1/users/{userId}/drafts'],
  list_workspace_drafts: ['gmail', 'GET', 'https://gmail.googleapis.com/gmail/v1/users/{userId}/drafts'],
  get_workspace_draft: ['gmail', 'GET', 'https://gmail.googleapis.com/gmail/v1/users/{userId}/drafts/{id}'],
  create_workspace_draft: ['gmail', 'POST', 'https://gmail.googleapis.com/gmail/v1/users/{userId}/drafts'],
  update_workspace_draft: ['gmail', 'PUT', 'https://gmail.googleapis.com/gmail/v1/users/{userId}/drafts/{id}'],
  delete_workspace_draft: ['gmail', 'DELETE', 'https://gmail.googleapis.com/gmail/v1/users/{userId}/drafts/{id}'],
  send_workspace_draft: ['gmail', 'POST', 'https://gmail.googleapis.com/gmail/v1/users/{userId}/drafts/send'],
  manage_workspace_attachment: ['gmail', 'GET', 'https://gmail.googleapis.com/gmail/v1/users/{userId}/messages/{messageId}/attachments/{id}'],
  download_workspace_attachment: ['gmail', 'GET', 'https://gmail.googleapis.com/gmail/v1/users/{userId}/messages/{messageId}/attachments/{id}'],
  upload_workspace_attachment: ['local', 'LOCAL', 'local://attachments/upload'],
  delete_workspace_attachment: ['local', 'LOCAL', 'local://attachments/{id}'],
  archive_workspace_email: ['gmail', 'POST', 'https://gmail.googleapis.com/gmail/v1/users/{userId}/messages/{id}/modify'],
  trash_workspace_email: ['gmail', 'POST', 'https://gmail.googleapis.com/gmail/v1/users/{userId}/messages/{id}/trash'],
  untrash_workspace_email: ['gmail', 'POST', 'https://gmail.googleapis.com/gmail/v1/users/{userId}/messages/{id}/untrash'],
  mark_workspace_email_read: ['gmail', 'POST', 'https://gmail.googleapis.com/gmail/v1/users/{userId}/messages/{id}/modify'],
  mark_workspace_email_unread: ['gmail', 'POST', 'https://gmail.googleapis.com/gmail/v1/users/{userId}/messages/{id}/modify'],
  manage_workspace_label: ['gmail', 'POST', 'https://gmail.googleapis.com/gmail/v1/users/{userId}/labels'],
  list_workspace_labels: ['gmail', 'GET', 'https://gmail.googleapis.com/gmail/v1/users/{userId}/labels'],
  get_workspace_label: ['gmail', 'GET', 'https://gmail.googleapis.com/gmail/v1/users/{userId}/labels/{id}'],
  create_workspace_label: ['gmail', 'POST', 'https://gmail.googleapis.com/gmail/v1/users/{userId}/labels'],
  update_workspace_label: ['gmail', 'PATCH', 'https://gmail.googleapis.com/gmail/v1/users/{userId}/labels/{id}'],
  delete_workspace_label: ['gmail', 'DELETE', 'https://gmail.googleapis.com/gmail/v1/users/{userId}/labels/{id}'],
  manage_workspace_label_assignment: ['gmail', 'POST', 'https://gmail.googleapis.com/gmail/v1/users/{userId}/messages/{id}/modify'],
  manage_workspace_label_filter: ['gmail', 'POST', 'https://gmail.googleapis.com/gmail/v1/users/{userId}/settings/filters'],
  list_workspace_label_filters: ['gmail', 'GET', 'https://gmail.googleapis.com/gmail/v1/users/{userId}/settings/filters'],
  create_workspace_label_filter: ['gmail', 'POST', 'https://gmail.googleapis.com/gmail/v1/users/{userId}/settings/filters'],
  update_workspace_label_filter: ['gmail', 'PATCH', 'https://gmail.googleapis.com/gmail/v1/users/{userId}/settings/filters/{id}'],
  delete_workspace_label_filter: ['gmail', 'DELETE', 'https://gmail.googleapis.com/gmail/v1/users/{userId}/settings/filters/{id}'],

  get_current_time: ['local', 'LOCAL', 'local://current-time'],
  find_free_slots: ['calendar', 'GET', 'https://www.googleapis.com/calendar/v3/freeBusy'],
  list_workspace_calendars: ['calendar', 'GET', 'https://www.googleapis.com/calendar/v3/users/me/calendarList'],
  list_workspace_calendar_events: ['calendar', 'GET', 'https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events'],
  get_workspace_calendar_event: ['calendar', 'GET', 'https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events/{eventId}'],
  manage_workspace_calendar_event: ['calendar', 'PATCH', 'https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events/{eventId}'],
  create_workspace_calendar_event: ['calendar', 'POST', 'https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events'],
  delete_workspace_calendar_event: ['calendar', 'DELETE', 'https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events/{eventId}'],
  respond_to_workspace_calendar_event: ['calendar', 'PATCH', 'https://www.googleapis.com/calendar/v3/calendars/primary/events/{eventId}'],

  list_drive_files: ['drive', 'GET', 'https://www.googleapis.com/drive/v3/files'],
  search_drive_files: ['drive', 'GET', 'https://www.googleapis.com/drive/v3/files'],
  upload_drive_file: ['drive', 'POST', 'https://www.googleapis.com/upload/drive/v3/files'],
  download_drive_file: ['drive', 'GET', 'https://www.googleapis.com/drive/v3/files/{fileId}'],
  create_drive_folder: ['drive', 'POST', 'https://www.googleapis.com/drive/v3/files'],
  update_drive_permissions: ['drive', 'POST', 'https://www.googleapis.com/drive/v3/files/{fileId}/permissions'],
  delete_drive_file: ['drive', 'DELETE', 'https://www.googleapis.com/drive/v3/files/{fileId}'],
  copy_drive_file: ['drive', 'POST', 'https://www.googleapis.com/drive/v3/files/{fileId}/copy'],
  move_drive_file: ['drive', 'PATCH', 'https://www.googleapis.com/drive/v3/files/{fileId}'],
  trash_drive_file: ['drive', 'PATCH', 'https://www.googleapis.com/drive/v3/files/{fileId}'],
  untrash_drive_file: ['drive', 'PATCH', 'https://www.googleapis.com/drive/v3/files/{fileId}'],
  list_file_revisions: ['drive', 'GET', 'https://www.googleapis.com/drive/v3/files/{fileId}/revisions'],
  download_file_revision: ['drive', 'GET', 'https://www.googleapis.com/drive/v3/files/{fileId}/revisions/{revisionId}'],

  get_workspace_contacts: ['contacts', 'GET', 'https://people.googleapis.com/v1/people/me/connections'],
  search_workspace_contacts: ['contacts', 'GET', 'https://people.googleapis.com/v1/people:searchContacts'],

  read_workspace_document: ['docs', 'GET', 'https://docs.googleapis.com/v1/documents/{documentId}'],
  create_workspace_document: ['docs', 'POST', 'https://docs.googleapis.com/v1/documents'],
  append_to_workspace_document: ['docs', 'POST', 'https://docs.googleapis.com/v1/documents/{documentId}:batchUpdate'],
  replace_workspace_document: ['docs', 'POST', 'https://docs.googleapis.com/v1/documents/{documentId}:batchUpdate'],
  find_and_replace_workspace_document: ['docs', 'POST', 'https://docs.googleapis.com/v1/documents/{documentId}:batchUpdate'],
  extract_workspace_document_id: ['local', 'LOCAL', 'local://document-id-extractor'],
  list_workspace_document_tabs: ['docs', 'GET', 'https://docs.googleapis.com/v1/documents/{documentId}'],
  batch_update_workspace_document: ['docs', 'POST', 'https://docs.googleapis.com/v1/documents/{documentId}:batchUpdate'],

  read_workspace_presentation: ['slides', 'GET', 'https://slides.googleapis.com/v1/presentations/{presentationId}'],
  create_workspace_presentation: ['slides', 'POST', 'https://slides.googleapis.com/v1/presentations'],
  list_workspace_presentation_slides: ['slides', 'GET', 'https://slides.googleapis.com/v1/presentations/{presentationId}'],
  get_workspace_slide: ['slides', 'GET', 'https://slides.googleapis.com/v1/presentations/{presentationId}'],
  extract_workspace_presentation_id: ['local', 'LOCAL', 'local://presentation-id-extractor'],
  batch_update_workspace_presentation: ['slides', 'POST', 'https://slides.googleapis.com/v1/presentations/{presentationId}:batchUpdate'],
  get_workspace_slide_thumbnail: ['slides', 'GET', 'https://slides.googleapis.com/v1/presentations/{presentationId}/pages/{pageObjectId}/thumbnail'],

  read_workspace_spreadsheet: ['sheets', 'GET', 'https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}'],
  read_workspace_spreadsheet_values: ['sheets', 'GET', 'https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}/values/{range}'],
  create_workspace_spreadsheet: ['sheets', 'POST', 'https://sheets.googleapis.com/v4/spreadsheets'],
  append_to_workspace_spreadsheet: ['sheets', 'POST', 'https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}/values/{range}:append'],
  update_workspace_spreadsheet_values: ['sheets', 'PUT', 'https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}/values/{range}'],
  clear_workspace_spreadsheet_values: ['sheets', 'POST', 'https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}/values/{range}:clear'],
  list_workspace_spreadsheet_sheets: ['sheets', 'GET', 'https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}'],
  add_workspace_spreadsheet_sheet: ['sheets', 'POST', 'https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}:batchUpdate'],
  delete_workspace_spreadsheet_sheet: ['sheets', 'POST', 'https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}:batchUpdate'],
  extract_workspace_spreadsheet_id: ['local', 'LOCAL', 'local://spreadsheet-id-extractor'],
  batch_read_workspace_spreadsheet_values: ['sheets', 'GET', 'https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}/values:batchGet'],
  batch_update_workspace_spreadsheet_values: ['sheets', 'POST', 'https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}/values:batchUpdate'],
  find_and_replace_workspace_spreadsheet: ['sheets', 'POST', 'https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}:batchUpdate'],
  format_workspace_spreadsheet_cells: ['sheets', 'POST', 'https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}:batchUpdate'],

  list_workspace_comments: ['drive', 'GET', 'https://www.googleapis.com/drive/v3/files/{fileId}/comments'],
  create_workspace_comment: ['drive', 'POST', 'https://www.googleapis.com/drive/v3/files/{fileId}/comments'],
  resolve_workspace_comment: ['drive', 'POST', 'https://www.googleapis.com/drive/v3/files/{fileId}/comments/{commentId}/replies'],
  reply_to_workspace_comment: ['drive', 'POST', 'https://www.googleapis.com/drive/v3/files/{fileId}/comments/{commentId}/replies'],
  delete_workspace_comment: ['drive', 'DELETE', 'https://www.googleapis.com/drive/v3/files/{fileId}/comments/{commentId}'],

  list_task_lists: ['tasks', 'GET', 'https://tasks.googleapis.com/tasks/v1/users/@me/lists'],
  list_tasks: ['tasks', 'GET', 'https://tasks.googleapis.com/tasks/v1/lists/{taskListId}/tasks'],
  create_task: ['tasks', 'POST', 'https://tasks.googleapis.com/tasks/v1/lists/{taskListId}/tasks'],
  update_task: ['tasks', 'PUT', 'https://tasks.googleapis.com/tasks/v1/lists/{taskListId}/tasks/{taskId}'],
  complete_task: ['tasks', 'PUT', 'https://tasks.googleapis.com/tasks/v1/lists/{taskListId}/tasks/{taskId}'],
  delete_task: ['tasks', 'DELETE', 'https://tasks.googleapis.com/tasks/v1/lists/{taskListId}/tasks/{taskId}'],

  list_forms: ['drive', 'GET', 'https://www.googleapis.com/drive/v3/files'],
  get_form: ['forms', 'GET', 'https://forms.googleapis.com/v1/forms/{formId}'],
  list_form_responses: ['forms', 'GET', 'https://forms.googleapis.com/v1/forms/{formId}/responses'],
  get_form_response: ['forms', 'GET', 'https://forms.googleapis.com/v1/forms/{formId}/responses/{responseId}'],
}));

function serviceFromCategory(category = '') {
  return category.split('/')[0].toLowerCase().replace('calendar', 'calendar');
}

function endpointFor(tool) {
  const override = endpointOverrides.get(tool.name);
  if (override) {
    return { service: override[0], method: override[1], path: override[2] };
  }
  const service = serviceFromCategory(tool.category);
  return {
    service,
    method: 'GOOGLEAPIS',
    path: `googleapis://${service}/${tool.name}`,
  };
}

const manifest = allTools
  .map((tool) => {
    const endpoint = endpointFor(tool);
    const handlerId = handlerByTool.get(tool.name) ?? 'unknown';
    return {
      tool: tool.name,
      service: endpoint.service,
      method: endpoint.method,
      path: endpoint.path,
      handlerId,
      handlerModule: handlerModuleByName.get(handlerId) ?? 'unknown',
    };
  })
  .sort((a, b) => a.tool.localeCompare(b.tool));

fs.writeFileSync(
  path.join(root, 'test/request-manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

console.log(`Generated test/request-manifest.json with ${manifest.length} entries`);
