#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "hello-harry-mcp",
  version: "0.1.0",
});

server.registerTool(
  "hello_harry",
  {
    title: "Hello Harry",
    description: `Say hello to Harry.

Returns a friendly greeting: "Hello Harry".

Examples:
  - Use when: "Say hello" or "Greet Harry" -> returns "Hello Harry"

No inputs required.`,
    inputSchema: z.object({}),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
    },
  },
  async () => {
    return {
      content: [
        {
          type: "text",
          text: "Hello Harry",
        },
      ],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server is running — listening on stdio
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
