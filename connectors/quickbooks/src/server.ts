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
} from './tools/index.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'quickbooks-mcp-server',
    version: '0.1.0',
  });

  registerConfigureTools(server);
  registerQueryTools(server);
  registerInvoiceTools(server);
  registerCustomerTools(server);
  registerBillTools(server);
  registerVendorTools(server);
  registerAccountTools(server);
  registerEmployeeTools(server);

  return server;
}
