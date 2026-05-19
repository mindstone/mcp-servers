# Changelog

All notable changes to `@mindstone/mcp-server-openai-image` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-05-19

### Added

- Initial open-source release of the OpenAI image generation MCP server.
- `generate_image` tool — text-to-image via OpenAI `gpt-image-2`.
- `edit_image` tool — image edits with up to 4 reference images and an optional mask.
- Structured `{ ok, code, error, resolution }` recovery contract across 8 error codes (`NOT_CONFIGURED`, `UPSTREAM_ERROR`, `TIMEOUT`, `INVALID_INPUT`, `FILE_NOT_FOUND`, `FILE_TOO_LARGE`, `WORKSPACE_VIOLATION`, `INTERNAL_ERROR`).
- `destructiveHint: true`, `openWorldHint: true`, `idempotentHint: false` annotations on both tools per the MCP tool-annotation contract.
- Configurable request timeout via `OPENAI_IMAGE_REQUEST_TIMEOUT_MS` (default 90 s), composing caller `AbortSignal` with the built-in timeout via `AbortSignal.any()`.
- Graceful unconfigured mode — when `OPENAI_API_KEY` is unset, empty, or equal to the literal `{{OPENAI_API_KEY}}` placeholder, the server starts cleanly and returns structured `NOT_CONFIGURED` per call instead of `process.exit(1)`.
- Workspace realpath fence on `edit_image.image_paths` and `edit_image.mask_path` to prevent symlink-escape and traversal.
- One-time idempotent legacy-folder migration (`RebelImages/` → `MCP-Generated-Images/`) when an existing Rebel host's user data is present and the target folder does not yet exist; aborts on symlinks at either path.
- Per-call sanitisation of OpenAI API keys, full prompts, and absolute file paths from logs, error payloads, and stack traces.
- 30 vitest tests across 11 files covering recovery contract, timeout behaviour, sanitisation, workspace fence, legacy migration, MIME validation, and unconfigured-mode startup.

### Security

- All known internal-reference / bridge-state hygiene strings (`MINDSTONE_REBEL_BRIDGE_STATE`, `MCP_HOST_BRIDGE_STATE`, `REBEL_WORKSPACE_PATH`, `nspr`) are absent from `src/`, `test/`, and the published tarball.
- `OPENAI_API_KEY` is read from `process.env` per tool call; the connector itself persists no credentials and writes no token files.
- See [Mindstone Rebel security review](https://github.com/mindstone/MindstoneRebel/blob/main/docs/reports/security-reviews/260503_openai-image_0.1.0.md) for the full § 13 pre-publish review record and live-API probe evidence.
