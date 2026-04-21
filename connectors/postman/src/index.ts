#!/usr/bin/env node
/**
 * MCP Server for Postman API
 *
 * This server provides tools to interact with the Postman API:
 * - postman_list_collections: List user's Postman collections
 * - postman_run_collection: Trigger a collection run in Postman's cloud
 * - postman_get_run_result: Poll a run result
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as logger from "./logger.js";

// =============================================================================
// Configuration
// =============================================================================

const POSTMAN_API_BASE_URL = process.env.POSTMAN_API_BASE_URL || "https://api.getpostman.com";
const POSTMAN_API_KEY = process.env.POSTMAN_API_KEY;

// Maximum response size (25KB) to prevent memory issues
const MAX_RESPONSE_SIZE = 25000;

// Validate required environment variables
if (!POSTMAN_API_KEY) {
  logger.error("POSTMAN_API_KEY environment variable is required");
  logger.error("Create a .env file with your Postman API key, or set it in Rebel's connector settings");
  process.exit(1);
}

// =============================================================================
// API Client
// =============================================================================

interface ApiResponse<T> {
  data?: T;
  error?: string;
}

async function apiRequest<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<ApiResponse<T>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(`${POSTMAN_API_BASE_URL}${endpoint}`, {
      ...options,
      signal: controller.signal,
      headers: {
        "Postman-Api-Key": POSTMAN_API_KEY as string,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      const truncated = errorText.length > 500 ? errorText.slice(0, 500) + "..." : errorText;
      return { error: `API error ${response.status}: ${truncated}` };
    }

    const text = await response.text();
    if (!text) {
      return { data: {} as T };
    }

    if (text.length > MAX_RESPONSE_SIZE) {
      logger.warn(`Response truncated from ${text.length} to ${MAX_RESPONSE_SIZE} chars`);
      const truncatedText = text.slice(0, MAX_RESPONSE_SIZE);
      try {
        const data = JSON.parse(truncatedText) as T;
        return { data };
      } catch {
        return {
          error: `Response too large (${text.length} chars). Consider using pagination or filters.`
        };
      }
    }

    try {
      const data = JSON.parse(text) as T;
      return { data };
    } catch {
      return { error: `Invalid JSON response: ${text.slice(0, 200)}...` };
    }
  } catch (error) {
    clearTimeout(timeout);
    if (error instanceof Error && error.name === "AbortError") {
      return { error: "Request timed out after 30 seconds" };
    }
    return { error: `Request failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// =============================================================================
// MCP Server Setup
// =============================================================================

const server = new McpServer({
  name: "postman-mcp",
  version: "1.0.0",
});

// =============================================================================
// Tool Schemas
// =============================================================================

const ListCollectionsSchema = z.object({
  limit: z.number().optional().default(100).describe("Maximum number of collections to return"),
});

const RunCollectionSchema = z.object({
  collection_uid: z.string().describe("The UID of the Postman collection to run"),
  environment_uid: z.string().optional().describe("Optional Postman environment UID to use during the run"),
});

const GetRunResultSchema = z.object({
  run_id: z.string().describe("The run ID returned by postman_run_collection"),
});

// =============================================================================
// Tool Implementations
// =============================================================================

// postman_list_collections
server.registerTool(
  "postman_list_collections",
  {
    title: "List Postman Collections",
    description: "List all of the authenticated user's Postman collections. Returns collection uid and name pairs.",
    inputSchema: ListCollectionsSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
    },
  },
  async ({ limit }) => {
    const result = await apiRequest<{ collections?: Array<{ uid: string; name: string }> }>(
      `/collections?limit=${limit}`
    );

    if (result.error) {
      return {
        content: [{ type: "text" as const, text: `Error: ${result.error}` }],
        isError: true,
      };
    }

    const collections = result.data?.collections ?? [];
    if (collections.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No collections found in your Postman account." }],
      };
    }

    const lines = collections.map((c) => `- **[${c.name}](https://api.getpostman.com/collections/${c.uid})** \`uid: ${c.uid}\``);
    const markdown = `## Postman Collections (${collections.length})\n\n${lines.join("\n")}`;

    return {
      content: [{ type: "text" as const, text: markdown }],
    };
  }
);

// postman_run_collection
server.registerTool(
  "postman_run_collection",
  {
    title: "Run Postman Collection",
    description: "Trigger a collection run in Postman's cloud infrastructure. Returns a run ID to poll with postman_get_run_result.",
    inputSchema: RunCollectionSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
    },
  },
  async ({ collection_uid, environment_uid }) => {
    const body: { environmentUid?: string } = {};
    if (environment_uid) {
      body.environmentUid = environment_uid;
    }

    const result = await apiRequest<{ runId?: string; id?: string }>(
      `/collections/${collection_uid}/runs`,
      {
        method: "POST",
        body: JSON.stringify(body),
      }
    );

    if (result.error) {
      return {
        content: [{ type: "text" as const, text: `Error: ${result.error}` }],
        isError: true,
      };
    }

    const runId = result.data?.runId ?? result.data?.id;
    if (!runId) {
      return {
        content: [{ type: "text" as const, text: "Error: No runId returned by Postman API." }],
        isError: true,
      };
    }

    return {
      content: [{ type: "text" as const, text: `Collection run started. Run ID: \`${runId}\`. Poll with postman_get_run_result.` }],
    };
  }
);

// postman_get_run_result
server.registerTool(
  "postman_get_run_result",
  {
    title: "Get Postman Run Result",
    description: "Poll the result of a Postman collection run. Returns status, pass/fail summary, timing, and error count.",
    inputSchema: GetRunResultSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
    },
  },
  async ({ run_id }) => {
    const result = await apiRequest<{
      status?: string;
      run?: {
        status?: string;
        timing?: { total?: number };
        stats?: {
          errors?: number;
          failed?: number;
          passed?: number;
        };
      };
      metrics?: {
        total?: number;
        failed?: number;
        errors?: number;
      };
      // Fallback for different response shapes
      total?: number;
      failed?: number;
      errors?: number;
    }>(`/runs/${run_id}`);

    if (result.error) {
      return {
        content: [{ type: "text" as const, text: `Error: ${result.error}` }],
        isError: true,
      };
    }

    const d = result.data;
    if (!d) {
      return {
        content: [{ type: "text" as const, text: "Error: Empty response from Postman API." }],
        isError: true,
      };
    }

    // Try primary shape first (run wrapper)
    const run = d.run;
    if (run) {
      const status = run.status ?? d.status ?? "unknown";
      const timing = run.timing?.total ?? 0;
      const errors = run.stats?.errors ?? 0;
      const failed = run.stats?.failed ?? 0;
      const passed = run.stats?.passed ?? 0;

      let statusLabel: string;
      if (status === "completed") {
        statusLabel = failed > 0 || errors > 0 ? "FAILED ❌" : "PASSED ✅";
      } else if (status === "running" || status === "queued") {
        statusLabel = `${status.toUpperCase()} ⏳`;
      } else {
        statusLabel = `${status.toUpperCase()}`;
      }

      const text = [
        `## Collection Run Result`,
        `**Run ID:** \`${run_id}\``,
        `**Status:** ${statusLabel}`,
        `**Timing:** ${timing}ms total`,
        `**Summary:** ${passed} passed | ${failed} failed | ${errors} errors`,
      ].join("\n");

      return {
        content: [{ type: "text" as const, text }],
      };
    }

    // Fallback: flat metrics shape
    const total = d.total ?? 0;
    const failed = d.failed ?? 0;
    const errors = d.errors ?? 0;
    const status = d.status ?? "unknown";

    const text = [
      `## Collection Run Result`,
      `**Run ID:** \`${run_id}\``,
      `**Status:** ${status}`,
      `**Total:** ${total} | **Failed:** ${failed} | **Errors:** ${errors}`,
    ].join("\n");

    return {
      content: [{ type: "text" as const, text }],
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
