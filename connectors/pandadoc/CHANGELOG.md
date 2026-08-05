# Changelog

All notable changes to this connector are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The history below `[Unreleased]` was reconstructed from git history during the
`@mindstone-engineering` to `@mindstone` npm scope migration; subsequent entries
are maintained manually as part of the PR review checklist.

## [Unreleased]

### Security
- Envelope all workspace-authored text returned by the document and template tools (names, recipients, created_by, fields, tokens, metadata, tags, grand_total, linked_objects) in `<untrusted-content>` envelopes with close-tag breakout escaping, via the shared `wrapUntrusted` helper vendored at `src/untrusted-content.ts` and field-level wrappers in `src/sanitize.ts`. Identifiers and URLs stay raw so downstream tool calls can still reference them. (FOX-3490 remediation.)

### Added
- `create_document_session` — create a view/sign session for a document recipient (`POST /documents/{id}/session`) and get back a shareable `https://app.pandadoc.com/s/{session_id}` link with an explicit lifetime. Marked `destructiveHint: true`: anyone with the link can view and sign until it expires.
- `list_document_folders` — list document folders (`GET /documents/folders`, with `parent_uuid` paging into subfolders) so `folder_uuid` inputs are discoverable in-product instead of requiring out-of-band knowledge.
- `list_contacts` — list workspace contacts (`GET /contacts`, optional exact-email filter) to discover existing recipients before creating or sending documents.
- `create_document_from_url` — create a document from a publicly accessible HTTPS PDF URL (`POST /documents` with `url`), sidestepping the local-file sandbox of `upload_document` for cloud-hosted files. Supports recipients, fields, tokens, metadata, tags, and `folder_uuid`; marked `destructiveHint: true`.
- `list_content_library_items` — search/list content library items (`GET /content-library-items` with q/id/folder/tag/deleted filters) for proposal assembly from approved reusable blocks.
- `get_content_library_item_details` — full content library item details (`GET /content-library-items/{id}/details`): roles, fields, tokens, pricing, metadata, and tags.

## [0.2.2] - 2026-05-14
### Added
- **registry**: Cohort A backfill — 12 API-key OSS connectors get server.json + mcpName. fathom, humaans, kling, mixmax, nano-banana, napkin, pandadoc, freshdesk, elevenlabs, retell-ai, runway, talentlms each gain a registry-shaped server.json (validated against registry.modelcontextprotocol.io) and an mcpName field on package.json under the io.github.mindstone namespace.
- **registry**: cohort review fixes + Office REBEL_OFFICE_* → MCP_OFFICE_* rename + browser-automation mcpName.

### Fixed
- **pandadoc**: sandbox upload_document reads + warn on send_document silent (M3.7)
- **pandadoc**: canonicalise path prefix before sandbox check (M3-fix-C)
- **ci**: Add npm overrides for fast-uri, hono, ip-address across all connectors.

### Changed
- Republished under the `@mindstone` npm scope. The legacy `@mindstone-engineering/mcp-server-*` package on this version line will be deprecated as part of the FOX-3319 scope migration; see [MIGRATION.md](../../MIGRATION.md) for the procedure consumers should follow.

## [0.2.1] - 2026-04-29

### Fixed
- **pandadoc**: Apply cohort sweep — read SERVER_VERSION from package.json (createRequire), add destructiveHint:true to mutating tools, add openWorldHint:true to remote-API tools (false on configure_*). Bump to 0.2.1. Mirrors retell-ai 92c9a40 fix to prevent SERVER_VERSION drift and align tool annotations across the cohort.

### Security
- **deps**: Bump vulnerable transitive deps to patched versions across all connectors. Resolves 52 dependabot moderate-severity alerts (27 hono, 22 postcss, 1 each @hono/node-server, esbuild, uuid).

## [0.2.0] - 2026-04-11

### Fixed
- **batch1**: bridge error propagation for Fathom/Mixmax/PandaDoc + Zod-before-outbound proof for all 6
- **bridge**: clean brand references from template and batch1 connectors
- **ci**: add npm audit step, fix QBOQL injection, add validateHostname, standardize mock keys

## [0.1.0] - 2026-04-09

### Added
- **pandadoc**: externalize PandaDoc MCP connector to standalone package


