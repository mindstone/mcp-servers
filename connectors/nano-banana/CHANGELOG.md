# Changelog

All notable changes to this connector are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The history below `[Unreleased]` was reconstructed from git history during the
`@mindstone-engineering` to `@mindstone` npm scope migration; subsequent entries
are maintained manually as part of the PR review checklist.

## [Unreleased]

### Added
- `nano_banana_generate` / `nano_banana_edit`: new optional `image_size` parameter (`"1K"` / `"2K"` / `"4K"`, default `"1K"`), forwarded as `generationConfig.imageConfig.imageSize`. An explicit `image_size` is refused with a structured `UNSUPPORTED_IMAGE_SIZE` error on `gemini-2.5-flash-image`, which only produces ~1K output.
- `nano_banana_edit`: multi-image input via the new `source_image_paths` array (up to 14 reference images, combinable with the legacy `source_image_path`) for multi-image composition/fusion. Every local source path stays sandboxed under `MCP_WORKSPACE_PATH` exactly as before.
- `nano_banana_edit`: source images may now be `https://` URLs (previously they fell through to a not-found error). Remote fetches are hardened: HTTPS only, userinfo refused, private/loopback/link-local hosts refused, redirects followed manually with every hop re-validated, a 20MB size cap enforced on both the Content-Length header and the streamed body, and a PNG/JPEG/WebP Content-Type check.

### Fixed
- Tool descriptions no longer advertise "4K" as a default trait of the default model — output resolution defaults to ~1K unless `image_size` is set explicitly.
- `nano_banana_generate` / `nano_banana_edit`: a failed `save_path` write no longer reports silent success — the tool now returns a structured `SAVE_FAILED` error (with the generated image still included inline, so the result is not lost).
- `nano_banana_generate` / `nano_banana_edit`: network-level failures (no HTTP response at all) now return the same structured error contract as API errors — `NETWORK_ERROR` with a `resolution` hint — instead of a bare `{ ok: false, error }`.

## [0.3.2] - 2026-05-14
### Added
- **registry**: Cohort A backfill — 12 API-key OSS connectors get server.json + mcpName. fathom, humaans, kling, mixmax, nano-banana, napkin, pandadoc, freshdesk, elevenlabs, retell-ai, runway, talentlms each gain a registry-shaped server.json (validated against registry.modelcontextprotocol.io) and an mcpName field on package.json under the io.github.mindstone namespace.

### Fixed
- **nano-banana**: sandbox nano_banana_edit source-image reads under MCP_WORKSPACE_PATH (M3.6)
- **nano-banana**: canonicalise path prefix before sandbox check (M3-fix-C)
- **ci**: Add npm overrides for fast-uri, hono, ip-address across all connectors.

### Changed
- Republished under the `@mindstone` npm scope. The legacy `@mindstone-engineering/mcp-server-*` package on this version line will be deprecated as part of the FOX-3319 scope migration; see [MIGRATION.md](../../MIGRATION.md) for the procedure consumers should follow.

## [0.3.1] - 2026-04-29

### Fixed
- **nano-banana**: Apply cohort sweep — read SERVER_VERSION from package.json (createRequire), add destructiveHint:true to mutating tools, add openWorldHint:true to remote-API tools (false on configure_*). Bump to 0.3.1. Mirrors retell-ai 92c9a40 fix to prevent SERVER_VERSION drift and align tool annotations across the cohort.

### Security
- **deps**: Bump vulnerable transitive deps to patched versions across all connectors. Resolves 52 dependabot moderate-severity alerts (27 hono, 22 postcss, 1 each @hono/node-server, esbuild, uuid).

## [0.3.0] - 2026-04-21

### Fixed
- **nano-banana**: Split Gemini vs bridge timeouts and raise Gemini default to 180s. Previously both shared a single 30s constant, causing gemini-3-pro-image-preview calls to spuriously TIMEOUT mid-generation.

## [0.2.0] - 2026-04-11

### Fixed
- **batch2**: fix 4 blocking scrutiny issues for ElevenLabs and Nano Banana
- **bridge**: clean brand references from batch2 connectors
- **ci**: add npm audit step, fix QBOQL injection, add validateHostname, standardize mock keys
- **ci**: standardize remaining mock API key fixtures to mcp-test-* pattern

## [0.1.0] - 2026-04-09

### Added
- **nano-banana**: externalize Nano Banana MCP connector to standalone package


