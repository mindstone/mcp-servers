import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerConfigureTools,
  registerQueryTools,
  registerInvoiceTools,
  registerCustomerTools,
  registerBillTools,
  registerVendorTools,
  registerAccountTools,
  registerEmployeeTools,
  registerReportTools,
} from './tools/index.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'quickbooks-mcp-server',
    version: pkg.version,
  });

  registerConfigureTools(server);
  registerQueryTools(server);
  registerInvoiceTools(server);
  registerCustomerTools(server);
  registerBillTools(server);
  registerVendorTools(server);
  registerAccountTools(server);
  registerEmployeeTools(server);
  registerReportTools(server);

  return server;
}
