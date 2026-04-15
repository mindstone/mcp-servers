import { z } from 'zod';
import { withErrorHandling } from '../utils.js';
export function registerHelloTools(server) {
    server.registerTool('humaans_hello_world', {
        description: 'Returns a simple greeting. Use this to verify the Humaans connector is reachable and responding.',
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true, destructiveHint: false },
    }, withErrorHandling(async () => {
        return JSON.stringify({ ok: true, message: 'Hello from Humaans MCP!' });
    }));
}
//# sourceMappingURL=hello.js.map