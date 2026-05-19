# @mindstone/mcp-server-openai-image

[![npm version](https://img.shields.io/npm/v/@mindstone/mcp-server-openai-image.svg)](https://www.npmjs.com/package/@mindstone/mcp-server-openai-image)
[![License: FSL-1.1-MIT](https://img.shields.io/badge/License-FSL--1.1--MIT-blue.svg)](./LICENSE)

OpenAI image generation MCP server for Model Context Protocol hosts. Generate and edit images via OpenAI's `gpt-image-2` model — sharp text rendering, multilingual support, four quality levels, three aspect ratios — through a standardised MCP interface.

## Requirements

- Node.js 20+
- npm
- OpenAI API key with image generation access

## Quick Start

### npx (once published)

```bash
npx -y @mindstone/mcp-server-openai-image
```

### Install & build from source

```bash
cd <path-to-repo>/connectors/openai-image
npm install
npm run build
node dist/index.js
```

## Configuration

### Environment variables

- `OPENAI_API_KEY` — OpenAI API key. Required for tool calls; if absent, the server starts in *unconfigured* mode and each tool call returns a structured `NOT_CONFIGURED` response instead of crashing.
- `MCP_WORKSPACE_PATH` — optional workspace path. Generated images are written under `<workspace>/Chief-of-Staff/generated-images/`. Defaults to `~/Pictures/MCP-Generated-Images/` when unset.
- `OPENAI_IMAGE_MODEL` — optional model override. Defaults to `gpt-image-2`.
- `OPENAI_IMAGE_REQUEST_TIMEOUT_MS` — optional override (positive integer ms, max 30 min) for the OpenAI image API timeout. Default: `90000` (90s). Raise if you see `TIMEOUT` errors on `count: 8` high-quality submits; lower for tighter bounds.

## Host configuration examples

### Claude Desktop / Cursor

```json
{
  "mcpServers": {
    "OpenAIImage": {
      "command": "npx",
      "args": ["-y", "@mindstone/mcp-server-openai-image"],
      "env": {
        "OPENAI_API_KEY": "your-openai-api-key"
      }
    }
  }
}
```

### Rebel

Use the catalog entry in Rebel's connector picker. Rebel injects `OPENAI_API_KEY` from your configured provider keys and points `MCP_WORKSPACE_PATH` at your active workspace.

## Tools

### `generate_image`

Inputs:
- `prompt` (string, required) — text description of the image to generate.
- `size` (`square | portrait | landscape`, optional) — 1024x1024, 1024x1536, 1536x1024.
- `quality` (`low | medium | high | auto`, optional) — defaults to `high`. Lower quality is dramatically cheaper.
- `count` (integer 1–8, optional) — defaults to 1. Cost scales linearly with count.
- `moderation` (`auto | low`, optional) — content moderation strictness.

Returns a text content block with the saved path(s) plus up to 5 inline `image` content blocks. On failure, returns a structured `{ ok: false, code, error, resolution }` response. The tool is annotated `destructiveHint: true, openWorldHint: true, idempotentHint: false`.

### `edit_image`

Inputs:
- `prompt` (string, required) — what to change about the input images.
- `image_paths` (array of 1–4 absolute file paths, required) — source images. Each path is validated against the realpath of `MCP_WORKSPACE_PATH` before any read.
- `mask_path` (PNG path, optional) — alpha-channel mask indicating which area to edit.
- `size`, `quality`, `count`, `moderation` — same shape as `generate_image`.

Returns the same content shape as `generate_image`. Same `destructiveHint` / `openWorldHint` / `idempotentHint` annotations.

## Recovery contract

Every tool error is returned as structured JSON with these fields:

```json
{
  "ok": false,
  "code": "NOT_CONFIGURED | UPSTREAM_ERROR | TIMEOUT | INVALID_INPUT | FILE_NOT_FOUND | FILE_TOO_LARGE | WORKSPACE_VIOLATION | INTERNAL_ERROR",
  "error": "Human-readable message",
  "resolution": "Concrete next step for the operator"
}
```

The structured shape lets agentic hosts route to recovery flows rather than surfacing raw exception text.

## Security disclosures

- Tool inputs that name local files (`edit_image.image_paths`, `edit_image.mask_path`) pass through a realpath fence before any read — paths that resolve outside `MCP_WORKSPACE_PATH` are rejected with `WORKSPACE_VIOLATION` to prevent symlink-escape and traversal.
- Generated files are written with mode `0o600`.
- `OPENAI_API_KEY` values are scrubbed from logs, structured error payloads, and stack traces — see `src/index.ts` `sanitizeForLog`.
- Prompts and absolute file paths are redacted from log output by default; only metadata (counts, sizes, timings, status codes) is logged.

## Legacy folder migration

Hosts that previously used a folder named `RebelImages/` under the workspace will see a one-time symlink-safe rename to `MCP-Generated-Images/` on first run. The migration is idempotent and skips when the target already exists; symlinks at either path abort the rename. The migration exists only to preserve existing user files; new installs go straight to `MCP-Generated-Images/`.

## License

[FSL-1.1-MIT](./LICENSE)
