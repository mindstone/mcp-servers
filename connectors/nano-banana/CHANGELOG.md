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

### Security
- `nano_banana_generate` / `nano_banana_edit`: the model's free-text part (returned when no image is produced) is now wrapped in an `<untrusted-content source="gemini">` envelope (canonical shared helper, vendored at `src/untrusted-content.ts`) instead of being returned raw — model-authored text reaches the host as data, not instructions. The connector's "returns only IDs/status/asset URLs" exemption in `scripts/untrusted-coverage-baseline.json` is now stale and can be dropped.

### Fixed
- Tool descriptions no longer advertise "4K" as a default trait of the default model — output resolution defaults to ~1K unless `image_size` is set explicitly.
- `nano_banana_generate` / `nano_banana_edit`: a failed `save_path` write no longer reports silent success — the tool now returns a structured `SAVE_FAILED` error (with the generated image still included inline, so the result is not lost).
- `nano_banana_generate` / `nano_banana_edit`: network-level failures (no HTTP response at all) now return the same structured error contract as API errors — `NETWORK_ERROR` with a `resolution` hint — instead of a bare `{ ok: false, error }`.
- Gemini API responses (success and error bodies) are now structurally validated with Zod instead of blind-cast; malformed 200 payloads fail with a structured `UNEXPECTED_RESPONSE` error rather than undefined-field behaviour downstream.

### Security
- Vendored `src/untrusted-content.ts` is now byte-for-byte the canonical strong helper: whitespace/case close-tag variants such as `</UNTRUSTED-CONTENT\n>` are neutralised, and `wrapUntrustedJsonStrings` also envelopes object keys.
- All remaining external-text paths are enveloped or sanitised: `promptFeedback.blockReason` is wrapped in an `<untrusted-content source="gemini">` envelope; Gemini error bodies and `Response.statusText` no longer reach model-visible error messages; a remote URL's `Content-Type` value is no longer echoed in `REMOTE_IMAGE_NOT_IMAGE` errors; and `inlineData.mimeType` is allow-listed (PNG/JPEG/WebP, logged fallback) instead of being forwarded verbatim.
- Remote source-image SSRF guard closed: hostnames are resolved via DNS and every resolved address is re-checked against the full non-public range list (now covering CGNAT 100.64.0.0/10, 192.0.0.0/24, benchmarking/documentation/multicast ranges, and IPv4-mapped IPv6 in both dotted and hex forms); unresolvable hosts fail closed, and every redirect hop is DNS-re-validated.
- Local source-image reads no longer have a check-then-use race: the validated canonical path is opened once, `fstat`-verified, re-checked for inode identity, and read through the same descriptor, so a symlink/file swap between validation and read fails closed.
- `save_path` writes no longer have a check-then-use race either: the destination directory is re-canonicalised at write time (a directory swapped for an escape symlink since validation fails closed), the bytes are staged in a fresh `mkdtemp` directory (0700) inside the verified directory and written owner-only (0600) through a single exclusive descriptor, then hard-linked into place — an existing file OR a planted symlink at the destination is never truncated or followed (`SAVE_EXISTS`).
- Local source images now honour the same 20MB per-image cap as remote fetches: the file size is checked from `fstat` before any bytes are read (and re-checked after), so an oversized in-workspace file fails with a structured `SOURCE_IMAGE_TOO_LARGE` error instead of being loaded into memory first.
- `save_path` writes are canonically contained (an in-workspace symlinked directory pointing outside the workspace is refused), the no-`MCP_WORKSPACE_PATH` write fallback is `os.tmpdir()` rather than the server process's cwd, and saves use `wx` (O_EXCL) — an existing file is never silently overwritten; the tool returns `SAVE_EXISTS` with the image still included inline.
- `nano_banana_generate` / `nano_banana_edit` now advertise `destructiveHint: true` (both can write files), and every source image is security-validated before the first network fetch — a mixed input like `[validRemoteUrl, "http://invalid"]` fails closed without any fetch.

### Changed
- `nano_banana_edit`: combined source images per call are now capped at 40MB total (`SOURCE_IMAGES_TOO_LARGE`), bounding per-call memory for multi-image requests.

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


