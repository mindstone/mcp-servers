import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerConfigureTools,
  registerMailboxTools,
  registerMessageTools,
  registerAttachmentTools,
  registerSendTools,
  registerDraftTools,
  registerCalendarTools,
} from './tools/index.js';
import { isCalendarEnabled } from './caldav/config.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'email-imap-mcp-server',
    version: pkg.version,
  });

  registerConfigureTools(server);
  registerMailboxTools(server);
  registerMessageTools(server);
  registerAttachmentTools(server);
  registerSendTools(server);
  registerDraftTools(server);

  // Calendar is opt-in: without EMAIL_IMAP_CALDAV_URL there is no endpoint to
  // talk to, and two tools that can only answer "not configured" are worse than
  // no tools at all. Read once here, at startup, so the advertised tool list is
  // stable for the life of the process.
  if (isCalendarEnabled()) {
    registerCalendarTools(server);
  }

  return server;
}
