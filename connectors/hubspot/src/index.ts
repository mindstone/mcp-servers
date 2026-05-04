#!/usr/bin/env node
import { HubSpotServer } from './tools/server.js';

const server = new HubSpotServer();

process.on('SIGINT', () => {
  process.exit(0);
});

process.on('SIGTERM', () => {
  process.exit(0);
});

server.run().catch(error => {
  console.error('Fatal Error:', error);
  process.exit(1);
});
