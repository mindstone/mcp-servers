import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerConfigureTools,
  registerUserTools,
  registerCourseTools,
  registerGroupTools,
  registerBranchTools,
  registerCategoryTools,
  registerReportingTools,
  registerAssessmentTools,
} from './tools/index.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'talentlms-mcp-server',
    version: pkg.version,
  });

  registerConfigureTools(server);
  registerUserTools(server);
  registerCourseTools(server);
  registerGroupTools(server);
  registerBranchTools(server);
  registerCategoryTools(server);
  registerReportingTools(server);
  registerAssessmentTools(server);

  return server;
}
