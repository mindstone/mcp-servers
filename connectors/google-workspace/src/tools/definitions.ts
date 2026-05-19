/**
 * Tool definitions for Google Workspace MCP
 * 
 * This file re-exports from the modular definitions directory.
 * For new code, prefer importing directly from './definitions/index.js'
 */

// Re-export everything from the modular definitions
export {
  accountTools,
  gmailTools,
  calendarTools,
  labelTools,
  driveTools,
  contactsTools,
  docsTools,
  slidesTools,
  sheetsTools,
  allTools
} from "./definitions/index.js";
