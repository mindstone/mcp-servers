import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerConfigureTools, registerPeopleTools, registerJobRoleTools, registerCompanyTools, registerTimeAwayTools, } from './tools/index.js';
export function createServer() {
    const server = new McpServer({
        name: 'humaans-mcp-server',
        version: '0.1.0',
    });
    registerConfigureTools(server);
    registerPeopleTools(server);
    registerJobRoleTools(server);
    registerCompanyTools(server);
    registerTimeAwayTools(server);
    return server;
}
//# sourceMappingURL=server.js.map