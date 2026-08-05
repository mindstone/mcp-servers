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
- Vendor-controlled text on error paths is no longer model-visible raw: API/upload error bodies and `info_message` responses are truncated and enveloped in `<untrusted-content>`, download failures surface only the numeric HTTP status (raw `statusText` dropped), malformed JSON responses fail closed with a generic message (no body fragments), and arbitrary runtime errors are API-key-redacted and length-bounded.
- Close-tag breakout escaping now covers all whitespace variants (`</untrusted-content\n>`, CR/FF/VT, etc.), not only space/tab.
- Structural keys (`id`, `uuid`, `url`, `shared_link`, …) stay raw only while the value still validates as the identifier/URL it claims to be; anything else is enveloped like other external text.
- `upload_document` validates and reads the workspace file through a single open descriptor (`open` once, `fstat`, read through the fd), closing the check-then-use race between sandbox validation and read.
- `download_document` writes under the canonical `os.tmpdir()` (never raw `TMPDIR`/`TEMP` strings) with a randomized filename and exclusive create — downloads never overwrite an existing file and cannot follow a pre-positioned symlink.
- `create_document_from_url` rejects loopback, link-local, private-range, and reserved literal hosts (IPv4 and IPv6, incl. IPv4-mapped), credential-bearing URLs, and internal hostname suffixes before any network call.

### Fixed
- `download_document` is no longer annotated `readOnlyHint: true` (it writes a local temp file); watermark inputs validate fail-closed (`watermark_color` must be `#RRGGBB`, `watermark_font_size` an integer 1-500, `watermark_opacity` 0-1).
- `list_contacts` accepts `count`/`page` and forwards them to the API instead of returning a single unpaginated response.
- List pagination hints no longer claim "Showing all results" or promise another page: the PandaDoc list API returns no totals, so hints now state what is actually known.
- Open-ended request bodies (`fields`, `metadata`, pricing-table `options`/`data`/`custom_fields`) validate as JSON-shaped values instead of `z.unknown()` pass-through.

### Added
- `create_document_session` — create a view/sign session for a document recipient (`POST /documents/{id}/session`) and get back a shareable `https://app.pandadoc.com/s/{session_id}` link with an explicit lifetime. Marked `destructiveHint: true`: anyone with the link can view and sign until it expires.
- `list_document_folders` — list document folders (`GET /documents/folders`, with `parent_uuid` paging into subfolders) so `folder_uuid` inputs are discoverable in-product instead of requiring out-of-band knowledge.
- `list_contacts` — list workspace contacts (`GET /contacts`, optional exact-email filter) to discover existing recipients before creating or sending documents.
- `create_document_from_url` — create a document from a publicly accessible HTTPS PDF URL (`POST /documents` with `url`), sidestepping the local-file sandbox of `upload_document` for cloud-hosted files. Supports recipients, fields, tokens, metadata, tags, and `folder_uuid`; marked `destructiveHint: true`.
- `list_content_library_items` — search/list content library items (`GET /content-library-items` with q/id/folder/tag/deleted filters) for proposal assembly from approved reusable blocks.
- `get_content_library_item_details` — full content library item details (`GET /content-library-items/{id}/details`): roles, fields, tokens, pricing, metadata, and tags.
- `create_document_from_template` now accepts `pricing_tables` to populate template pricing tables at creation time (sections, rows, options, custom fields), matching the PandaDoc `PricingTableRequest` schema.

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


