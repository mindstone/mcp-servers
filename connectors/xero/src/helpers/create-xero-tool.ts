import { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ToolDefinition } from "../types/tool-definition.js";
import { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { wrapUntrusted } from "../untrusted-content.js";
import { formatError } from "./format-error.js";

/**
 * AGENTS.md security invariant #6: any text block a tool returns can carry
 * Xero-authored (attacker-controllable) text — contact names, line item
 * descriptions, references, history details/changes, validation messages.
 * Envelope every text block here, at the single factory every tool is built
 * with, so individual tools cannot forget to wrap their external text.
 */
function envelopToolResult(
  result: CallToolResult,
  source: string,
): CallToolResult {
  return {
    ...result,
    content: result.content?.map((block) =>
      block.type === "text"
        ? { ...block, text: wrapUntrusted(block.text, source) ?? block.text }
        : block,
    ),
  };
}

export const CreateXeroTool =
  <Args extends ZodRawShapeCompat>(
    name: string,
    description: string,
    schema: Args,
    handler: ToolCallback<Args>,
  ): (() => ToolDefinition<ZodRawShapeCompat>) =>
  () => ({
    name: name,
    description: description,
    schema: schema,
    handler: (async (args, extra) => {
      try {
        return envelopToolResult(await handler(args, extra), `xero.${name}`);
      } catch (error) {
        // A rejection would otherwise bypass the envelope: the SDK serialises
        // the raw error message into a plain, unwrapped text block. Format it
        // (whitelisted fields only — SDK rejections can carry bearer tokens)
        // and route it through the same choke point as any other result.
        return envelopToolResult(
          {
            content: [{ type: "text" as const, text: formatError(error) }],
            isError: true,
          },
          `xero.${name}`,
        );
      }
    }) as ToolCallback<Args>,
  });
