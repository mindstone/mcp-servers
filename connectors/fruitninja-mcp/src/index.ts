#!/usr/bin/env node
/**
 * FruitNinja MCP Server
 *
 * Tells you the optimal way to cut any piece of fruit.
 * Data is static — no API key or network connection required.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as logger from "./logger.js";
import { findFruit, listFruits, FRUIT_DATABASE } from "./data.js";

// =============================================================================
// MCP Server Setup
// =============================================================================

const server = new McpServer({
  name: "fruitninja-mcp",
  version: "1.0.0",
});

// =============================================================================
// Tool: get_cutting_guide
// =============================================================================

const GetCuttingGuideInputSchema = z.object({
  fruit: z.string()
    .min(1, "Fruit name is required")
    .max(100, "Fruit name must not exceed 100 characters")
    .describe("The name of the fruit you want to cut (e.g. 'mango', 'pineapple', 'avocado')"),
}).strict();

type GetCuttingGuideInput = z.infer<typeof GetCuttingGuideInputSchema>;

server.registerTool(
  "get_cutting_guide",
  {
    title: "Get Fruit Cutting Guide",
    description: `Get the optimal cutting technique for a specific fruit.

Returns step-by-step instructions, required tools, difficulty level, tips, and safety notes.

Args:
  - fruit (string): Name of the fruit (e.g. "mango", "pineapple", "avocado", "kiwi")

Returns:
  Full cutting guide including technique, steps, tips, safety notes, and serving ideas.

Example:
  - "How do I cut a mango?" -> { fruit: "mango" }
  - "Best way to cut a pineapple?" -> { fruit: "pineapple" }`,
    inputSchema: GetCuttingGuideInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params: GetCuttingGuideInput) => {
    const entry = findFruit(params.fruit);

    if (!entry) {
      const available = listFruits().join(", ");
      return {
        isError: true,
        content: [{
          type: "text",
          text: `🍽️ FruitNinja doesn't have a guide for "${params.fruit}" yet.\n\nAvailable fruits: ${available}\n\nTry one of these, or check the spelling.`,
        }],
      };
    }

    const difficultyEmoji = { easy: "🟢", medium: "🟡", hard: "🔴" }[entry.difficulty];
    const stepsFormatted = entry.steps
      .map((s) => `   ${s.step}. ${s.instruction}`)
      .join("\n");
    const tipsFormatted = entry.tips.map((t) => `   • ${t}`).join("\n");
    const safetyFormatted = entry.safetyNotes.map((n) => `   ⚠️  ${n}`).join("\n");
    const servingFormatted = entry.servingIdeas.join(", ");

    const guide = `# ${entry.emoji} How to Cut a ${entry.name.charAt(0).toUpperCase() + entry.name.slice(1)}

**Technique**: ${entry.technique}
**Difficulty**: ${difficultyEmoji} ${entry.difficulty}
**Tools needed**: ${entry.tools.join(", ")}

## Preparation
${entry.preparation}

## Steps
${stepsFormatted}

## Tips
${tipsFormatted}

## Safety
${safetyFormatted}

## Serving ideas
${servingFormatted}`;

    return {
      content: [{ type: "text", text: guide }],
    };
  }
);

// =============================================================================
// Tool: list_fruits
// =============================================================================

server.registerTool(
  "list_fruits",
  {
    title: "List Available Fruits",
    description: `List all fruits that FruitNinja has cutting guides for.

Use this when the user asks what fruits are supported, or before calling get_cutting_guide if unsure whether a fruit is in the dataset.

Returns:
  List of supported fruit names with emoji.`,
    inputSchema: z.object({}).strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    const lines = FRUIT_DATABASE.map(
      (f) => `${f.emoji} **${f.name}** — ${f.technique} (${f.difficulty})`
    ).join("\n");

    return {
      content: [{
        type: "text",
        text: `# 🍴 FruitNinja — Supported Fruits\n\n${lines}\n\nUse \`get_cutting_guide\` with any fruit name above for full step-by-step instructions.`,
      }],
    };
  }
);

// =============================================================================
// Tool: compare_fruits
// =============================================================================

const CompareFruitsInputSchema = z.object({
  fruits: z.array(z.string().min(1).max(100))
    .min(2, "Provide at least 2 fruits to compare")
    .max(5, "Provide at most 5 fruits to compare")
    .describe("List of 2–5 fruit names to compare side-by-side"),
}).strict();

type CompareFruitsInput = z.infer<typeof CompareFruitsInputSchema>;

server.registerTool(
  "compare_fruits",
  {
    title: "Compare Fruit Cutting Difficulty",
    description: `Compare the cutting difficulty and requirements for multiple fruits side by side.

Useful when the user wants to pick the easiest fruit to prepare, or plan a fruit platter.

Args:
  - fruits (string[]): 2–5 fruit names to compare

Returns:
  Side-by-side comparison of difficulty, tools, and technique for each fruit.

Example:
  - "Which is easier to cut, mango or pineapple?" -> { fruits: ["mango", "pineapple"] }
  - "Compare apple, kiwi, and strawberry" -> { fruits: ["apple", "kiwi", "strawberry"] }`,
    inputSchema: CompareFruitsInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params: CompareFruitsInput) => {
    const results = params.fruits.map((name) => ({
      name,
      entry: findFruit(name),
    }));

    const notFound = results.filter((r) => !r.entry).map((r) => r.name);
    if (notFound.length > 0) {
      return {
        isError: true,
        content: [{
          type: "text",
          text: `FruitNinja doesn't have guides for: ${notFound.join(", ")}.\n\nAvailable fruits: ${listFruits().join(", ")}`,
        }],
      };
    }

    const difficultyEmoji = { easy: "🟢", medium: "🟡", hard: "🔴" };
    const rows = results.map((r) => {
      const e = r.entry!;
      return `| ${e.emoji} ${e.name} | ${difficultyEmoji[e.difficulty]} ${e.difficulty} | ${e.technique} | ${e.tools.join(", ")} |`;
    });

    const table = [
      "| Fruit | Difficulty | Technique | Tools |",
      "|-------|------------|-----------|-------|",
      ...rows,
    ].join("\n");

    return {
      content: [{ type: "text", text: `# 🍴 Fruit Cutting Comparison\n\n${table}` }],
    };
  }
);

// =============================================================================
// Start Server
// =============================================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("FruitNinja MCP server running via stdio");
}

main().catch((err) => {
  logger.error("Server error", err);
  process.exit(1);
});
