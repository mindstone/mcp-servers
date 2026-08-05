import { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { ToolDefinition } from "../types/tool-definition.js";

export const XERO_ALLOW_WRITES_ENV = "XERO_ALLOW_WRITES";

/**
 * Secure-by-default write gate for Xero mutating tools.
 *
 * Xero writes (creating/updating/deleting invoices, contacts, payments,
 * purchase orders, notes, etc.) are gated behind the `XERO_ALLOW_WRITES`
 * environment variable. The value MUST be exactly the string `"1"` — any
 * other value (including unset, empty string, `"true"`, `"yes"`, or `"0"`)
 * keeps the gate closed.
 *
 * This guard prevents an LLM agent from accidentally writing to a real
 * Xero organisation. Hosts that intend writes to occur must explicitly opt
 * in by setting the environment variable.
 */
export function writesAllowed(): boolean {
  return process.env[XERO_ALLOW_WRITES_ENV] === "1";
}

/**
 * Wrap a write tool's handler so it refuses to run while the gate is
 * closed. The refusal names the env var so the caller can act on it.
 */
export function withWriteGate(
  tool: ToolDefinition<ZodRawShapeCompat>,
): ToolDefinition<ZodRawShapeCompat> {
  const gated: ToolCallback<ZodRawShapeCompat> = async (args, extra) => {
    if (!writesAllowed()) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Error: the "${tool.name}" tool refuses to run unless ` +
              `${XERO_ALLOW_WRITES_ENV}=1 is set. This guard is secure-by-default: ` +
              "it prevents an agent from accidentally performing a destructive " +
              "write against a real Xero organisation. Set " +
              `${XERO_ALLOW_WRITES_ENV}=1 in the host environment only when you ` +
              "intend Xero writes to occur. Read-only tools (list/get) are " +
              "unaffected by this gate.",
          },
        ],
        isError: true,
      };
    }
    return tool.handler(args, extra);
  };

  return { ...tool, handler: gated };
}
