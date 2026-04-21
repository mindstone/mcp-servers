# Hello World MCP — Build Plan

## Overview
A minimal Hello World MCP server demonstrating the basic MCP server pattern with McpServer + registerTool + Zod.

## Goals
- Demonstrate the canonical MCP server pattern (stdio transport, Zod input validation, tool annotations)
- Provide two simple tools: `say_hello` and `echo`
- Serve as a reference template for future MCP connectors

## Tool Surface

| Tool Name | Description | Input | Output |
|---|---|---|---|
| `hello_world_say_hello` | Greet someone by name | `name: string` (default: "World") | `Hello, {name}! 👋` |
| `hello_world_echo` | Echo a message back verbatim | `message: string` | Same message |

## Implementation Notes
- Uses `@modelcontextprotocol/sdk` v1.6.1 with `McpServer` + `registerTool()`
- Stdio transport
- All annotations set: `readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false`
- snake_case tool names and parameter names throughout
- No credentials required (public, no-auth API)

## Build & Test Results
- `npm run build` ✓ (tsc, no errors)
- `npm test` ✓ (4/4 tests passing)
- `npm audit` ✓ (1 moderate severity vulnerability in transitive `hono` dep — not exploitable via stdio connector)
- Connector registered in Rebel as `hello-world-mcp` (stdio transport)

## Quality Checklist
- [x] Build passes
- [x] Tests exist and pass (happy path + edge cases)
- [x] No hardcoded credentials
- [x] snake_case naming throughout
- [x] Tool annotations set correctly
- [x] `.env.example` exists (no credentials needed)
- [x] `bin` field points to `dist/index.js`
- [x] `files: ["dist"]` in package.json
