import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerConfigureTools,
  registerSequenceTools,
  registerMessageTools,
  registerSnippetTools,
  registerMeetingTools,
  registerUserTools,
} from './tools/index.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'mixmax-mcp-server',
    version: '0.1.0',
  });

  registerConfigureTools(server);
  registerSequenceTools(server);
  registerMessageTools(server);
  registerSnippetTools(server);
  registerMeetingTools(server);
  registerUserTools(server);

  return server;
}
