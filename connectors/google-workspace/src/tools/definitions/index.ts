/**
 * Tool definitions for Google Workspace MCP
 * 
 * This module exports all tool definitions organized by service:
 * - Account management
 * - Gmail (messages, settings, drafts)
 * - Calendar (events, availability)
 * - Labels (Gmail label management)
 * - Drive (files, folders, permissions)
 * - Contacts
 * - Docs (documents)
 * - Slides (presentations)
 * - Sheets (spreadsheets)
 * - Tasks (task lists, tasks)
 * - Forms (read-only access to forms and responses)
 */

import { createRequire } from 'node:module';
import { ToolMetadata } from "../../modules/tools/registry.js";

// Import tool definitions from each module
export { accountTools } from "./account.js";
export { gmailTools } from "./gmail.js";
export { calendarTools } from "./calendar.js";
export { labelTools } from "./labels.js";
export { driveTools } from "./drive.js";
export { contactsTools } from "./contacts.js";
export { docsTools } from "./docs.js";
export { slidesTools } from "./slides.js";
export { sheetsTools } from "./sheets.js";
export { commentsTools } from "./comments.js";
export { tasksTools } from "./tasks.js";
export { formsTools } from "./forms.js";
export { chatTools } from "./chat.js";
export { meetTools } from "./meet.js";

// Import for combining into allTools
import { accountTools } from "./account.js";
import { gmailTools } from "./gmail.js";
import { calendarTools } from "./calendar.js";
import { labelTools } from "./labels.js";
import { driveTools } from "./drive.js";
import { contactsTools } from "./contacts.js";
import { docsTools } from "./docs.js";
import { slidesTools } from "./slides.js";
import { sheetsTools } from "./sheets.js";
import { commentsTools } from "./comments.js";
import { tasksTools } from "./tasks.js";
import { formsTools } from "./forms.js";
import { chatTools } from "./chat.js";
import { meetTools } from "./meet.js";

const require = createRequire(import.meta.url);
export const DESTRUCTIVE_OVERRIDES = require('./destructive-overrides.json') as Record<string, boolean>;
export const OPEN_WORLD_OVERRIDES = require('./open-world-overrides.json') as Record<string, boolean>;

function withCohortAnnotations(tool: ToolMetadata): ToolMetadata {
  const destructiveHint = DESTRUCTIVE_OVERRIDES[tool.name] ?? false;
  const openWorldHint = OPEN_WORLD_OVERRIDES[tool.name] ?? true;
  return {
    ...tool,
    annotations: {
      ...(tool.annotations ?? {}),
      destructiveHint,
      openWorldHint
    }
  };
}

// Export all tools combined - maintains backward compatibility
const rawTools: ToolMetadata[] = [
  ...accountTools,
  ...gmailTools,
  ...calendarTools,
  ...labelTools,
  ...driveTools,
  ...contactsTools,
  ...docsTools,
  ...slidesTools,
  ...sheetsTools,
  ...commentsTools,
  ...chatTools,
  ...meetTools,
  ...tasksTools,
  ...formsTools,
];

export const allTools: ToolMetadata[] = rawTools.map(withCohortAnnotations);
