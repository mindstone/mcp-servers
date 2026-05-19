#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createServer } from './server.js';

const server = createServer();
const transport = new StdioServerTransport();
server.connect(transport)
  .then(() => {
    console.error('[Vanta] Server started');
  })
  .catch((err) => {
    console.error('[Vanta] Failed to start', err);
    process.exit(1);
  });
