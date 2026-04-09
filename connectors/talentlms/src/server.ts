import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerConfigureTools,
  registerUserTools,
  registerCourseTools,
  registerGroupTools,
  registerBranchTools,
  registerReportingTools,
  registerAssessmentTools,
} from './tools/index.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'talentlms-mcp-server',
    version: '0.1.0',
  });

  registerConfigureTools(server);
  registerUserTools(server);
  registerCourseTools(server);
  registerGroupTools(server);
  registerBranchTools(server);
  registerReportingTools(server);
  registerAssessmentTools(server);

  return server;
}
