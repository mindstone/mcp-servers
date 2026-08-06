# Changelog

All notable changes to this connector are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The history below `[Unreleased]` was reconstructed from git history during the
`@mindstone-engineering` to `@mindstone` npm scope migration; subsequent entries
are maintained manually as part of the PR review checklist.

## [Unreleased]

### Added
- **napkin**: Add `napkin_list_styles` tool exposing the 15 built-in Napkin style catalog (IDs, descriptions, categories) so models can pick a `style_id` without copying one from the app UI. Static catalog data — no API key or network call required.

### Fixed
- **napkin**: Map HTTP 410 responses (status/file URLs expire 30 minutes after generation) to a structured `EXPIRED` error with an actionable regenerate-and-download-promptly resolution, instead of generic `API_ERROR`/`DOWNLOAD_ERROR`.
- **napkin**: Broaden the 403 `AUTH_FAILED` resolution — the vendor returns 403 ("user not found") for invalid keys too, not only for missing permissions, so the message now points at checking the key.
- **napkin**: A failed format-detection pre-check in `napkin_download_visual` now logs an explicit stderr warning before falling back to the default `.svg` extension, instead of failing silently.
- **napkin**: A `filename` that slugifies to an empty string now falls back to a timestamped name instead of producing a hidden dotfile.

### Security
- **napkin**: Harden `napkin_download_visual`'s download target. The output directory is now canonicalised with canonical-prefix containment beneath `MCP_WORKSPACE_PATH` (or the home-directory fallback), so a symlinked `Chief-of-Staff`/`generated-visuals` component fails closed with an observable `OUTPUT_PATH_REJECTED` error instead of redirecting the write. Downloads are written to a fresh private staging directory (mode 0700) and hard-linked into place with exclusive-create semantics: existing files are never overwritten (`FILE_EXISTS` error) and a pre-planted symlink at the destination is never followed.
- **napkin**: `napkin_download_visual` no longer auto-follows redirects. Downloads now fetch with `redirect: 'manual'`, re-validate every `Location` target against the same download allow-list (HTTPS-only, no userinfo, no private/loopback/reserved hosts), and cap the chain at 5 hops — a 30x from the API host can no longer smuggle the request (and the bytes written to disk) to an internal or attacker-controlled host. Refusals surface as a structured `REDIRECT_REJECTED` error that never echoes the redirect target's path or query.
- **napkin**: Envelope vendor-authored free text in `<untrusted-content>` envelopes (AGENTS.md invariant #6) with close-tag breakout escaping: `warnings[].message` and `error.message` in `napkin_check_status` output, and the HTTP reason phrase in `DOWNLOAD_ERROR` messages. Machine identifiers (codes, IDs, URLs) stay raw so tool output remains directly usable.
- **napkin**: Validate every Napkin API response body fail-closed with Zod before it reaches tool code. Malformed JSON or a shape mismatch now surfaces as a structured `INVALID_RESPONSE` error instead of an unstructured `TypeError` from a bare cast, and raw parser messages (which can embed fragments of the vendor payload) never reach model-visible output.

## [0.3.2] - 2026-05-14
### Added
- **registry**: Cohort A backfill — 12 API-key OSS connectors get server.json + mcpName. fathom, humaans, kling, mixmax, nano-banana, napkin, pandadoc, freshdesk, elevenlabs, retell-ai, runway, talentlms each gain a registry-shaped server.json (validated against registry.modelcontextprotocol.io) and an mcpName field on package.json under the io.github.mindstone namespace.

### Fixed
- **napkin**: allow-list file_url hosts to prevent Bearer-token exfil (M2.1)
- **napkin**: hoist file_url validation before any outbound network call (M2-fix-1)
- **ci**: Add npm overrides for fast-uri, hono, ip-address across all connectors.

### Changed
- Republished under the `@mindstone` npm scope. The legacy `@mindstone-engineering/mcp-server-*` package on this version line will be deprecated as part of the FOX-3319 scope migration; see [MIGRATION.md](../../MIGRATION.md) for the procedure consumers should follow.

## [0.3.1] - 2026-04-29

### Fixed
- **napkin**: Apply cohort sweep — read SERVER_VERSION from package.json (createRequire), add destructiveHint:true to mutating tools, add openWorldHint:true to remote-API tools (false on configure_*). Bump to 0.3.1. Mirrors retell-ai 92c9a40 fix to prevent SERVER_VERSION drift and align tool annotations across the cohort.

### Security
- **deps**: Bump vulnerable transitive deps to patched versions across all connectors. Resolves 52 dependabot moderate-severity alerts (27 hono, 22 postcss, 1 each @hono/node-server, esbuild, uuid).

## [0.3.0] - 2026-04-21

### Added
- **connectors**: Harden request timeouts across 4 long-running generation connectors. Follows nano-banana-v0.3.0 (139d488) — same hard-coded 30s timeout class of bug applies to polling-style generation APIs.

## [0.2.0] - 2026-04-11

### Fixed
- **bridge**: clean brand references from batch2 connectors
- **napkin**: mark MINDSTONE_REBEL_BRIDGE_STATE as Legacy/deprecated in index.ts header
- **ci**: add npm audit step, fix QBOQL injection, add validateHostname, standardize mock keys
- **ci**: standardize remaining mock API key fixtures to mcp-test-* pattern

## [0.1.0] - 2026-04-09

### Added
- **napkin**: externalize Napkin MCP connector to standalone package


