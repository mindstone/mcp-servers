#!/usr/bin/env node
/**
 * Hello World MCP Server
 *
 * A minimal MCP server demonstrating the basic pattern:
 * - McpServer + registerTool + Zod
 * - Stdio transport
 * - Annotations
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "hello-world-mcp-server",
  version: "1.0.0",
});

// Tool 1: say_hello — greet a name
server.registerTool(
  "hello_world_say_hello",
  {
    title: "Say Hello",
    description: `Greet someone by name.

Args:
  - name (string): The name to greet (default: "World")

Returns:
  A friendly greeting string.

Example:
  - "Hello, Harry!"`,
    inputSchema: z.object({
      name: z
        .string()
        .min(1)
        .max(100)
        .default("World")
        .describe('Name to greet (default: "World")'),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ name }) => {
    return {
      content: [{ type: "text", text: `Hello, ${name}! 👋` }],
    };
  }
);

// Tool 2: hello_world_echo — echo a message back
server.registerTool(
  "hello_world_echo",
  {
    title: "Echo",
    description: `Echo a message back verbatim.

Args:
  - message (string): The message to echo back

Returns:
  The same message, unchanged.`,
    inputSchema: z.object({
      message: z
        .string()
        .min(1)
        .max(500)
        .describe("The message to echo back"),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ message }) => {
    return {
      content: [{ type: "text", text: message }],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Hello World MCP server running via stdio ✓");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
