#!/usr/bin/env node
import { createRequire } from 'node:module';
import { GSuiteServer } from './tools/server.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

if (process.argv.includes('--version') || process.argv.includes('-v')) {
  console.log(version);
  process.exit(0);
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('Google Workspace MCP Server. Configure GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ACCOUNTS_PATH, and CREDENTIALS_PATH, then run over stdio from an MCP host.');
  process.exit(0);
}

// Start server with proper shutdown handling
const server = new GSuiteServer();

// Handle process signals
process.on('SIGINT', () => {
  process.exit(0);
});

process.on('SIGTERM', () => {
  process.exit(0);
});

// Start with error handling
server.run().catch(error => {
  console.error('Fatal Error:', error);
  process.exit(1);
});
