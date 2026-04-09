#!/usr/bin/env node
/**
 * TalentLMS MCP Server
 *
 * Comprehensive LMS integration via TalentLMS API:
 * - Users (list, get, create, status, courses)
 * - Courses (list, get, create, users, enrol, unenrol, SSO)
 * - Groups (list, get, create, add course)
 * - Branches (list)
 * - Reporting (site info, timeline, user progress)
 * - Assessments (test answers, survey answers, ILT sessions)
 *
 * Environment variables:
 * - TALENTLMS_API_KEY: TalentLMS API key (Super Admin required)
 * - TALENTLMS_DOMAIN: TalentLMS subdomain (e.g., "acme" for acme.talentlms.com)
 * - MCP_HOST_BRIDGE_STATE: Path to host app bridge state file (optional)
 * - MINDSTONE_REBEL_BRIDGE_STATE: Legacy bridge state path (optional)
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('TalentLMS MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
