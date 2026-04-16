#!/usr/bin/env node
/**
 * MCP Server for Random Number Generation
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as logger from "./logger.js";

// =============================================================================
// MCP Server Setup
// =============================================================================

const server = new McpServer({
  name: "random-number-mcp",
  version: "1.0.0",
});

// =============================================================================
// Tool: Generate Random Number
// =============================================================================

const GenerateRandomNumberInputSchema = z.object({
  min: z.number()
    .int()
    .default(1)
    .describe("Minimum value (inclusive)"),
  max: z.number()
    .int()
    .default(100)
    .describe("Maximum value (inclusive)"),
}).strict();

type GenerateRandomNumberInput = z.infer<typeof GenerateRandomNumberInputSchema>;

server.registerTool(
  "generate_random_number",
  {
    title: "Generate Random Number",
    description: `Generate a random integer between two values.

Use this tool when the user wants a random number for any purpose.

Args:
  - min (number): Minimum value, inclusive (default: 1)
  - max (number): Maximum value, inclusive (default: 100)

Returns:
  A random integer between min and max (inclusive).

Examples:
  - "Give me a random number" -> { min: 1, max: 100 }
  - "Random number between 1 and 10" -> { min: 1, max: 10 }
  - "Random number between 50 and 100" -> { min: 50, max: 100 }`,
    inputSchema: GenerateRandomNumberInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async (params: GenerateRandomNumberInput) => {
    const min = params.min;
    const max = params.max;

    if (min > max) {
      return {
        isError: true,
        content: [{ type: "text", text: `Invalid range: min (${min}) must be less than or equal to max (${max})` }],
      };
    }

    const randomNumber = Math.floor(Math.random() * (max - min + 1)) + min;

    return {
      content: [{
        type: "text",
        text: `Random number: ${randomNumber}`,
      }],
    };
  }
);

// =============================================================================
// Start Server
// =============================================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("MCP server running via stdio");
}

main().catch((err) => {
  logger.error("Server error", err);
  process.exit(1);
});
