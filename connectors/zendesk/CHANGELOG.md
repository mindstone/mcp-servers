# Changelog

All notable changes to this connector are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The history below `[Unreleased]` was reconstructed from git history during the
`@mindstone-engineering` to `@mindstone` npm scope migration; subsequent entries
are maintained manually as part of the PR review checklist.

## [Unreleased]

### Security
- Migrated the untrusted-content envelope from the connector-local hand-rolled implementation to the canonical shared helper (`src/untrusted-content.ts`, vendored from the connector template per security invariant #6) and extended coverage: ticket subjects are now enveloped in every read path (previously only search results), and user names/emails, organization names, and macro titles are enveloped as well.

### Added
- `list_zendesk_satisfaction_ratings` — list customer satisfaction (CSAT) ratings with score/date filters for support-quality reporting. Customer comments are enveloped as untrusted content.
- `create_or_update_zendesk_user` — create a user or update the existing one with the same email (`POST /api/v2/users/create_or_update.json`), enabling "add this new customer contact" flows. Marked `destructiveHint: true` per security invariant #7.
- `get_zendesk_organization` — fetch a single organization by ID for customer context.
- `search_zendesk_help_center_articles` and `get_zendesk_help_center_article` — search and read Zendesk Help Center (Guide) articles so support replies can be grounded in the company's own knowledge base. Titles, snippets, and bodies are enveloped as untrusted content.
- `list_zendesk_view_tickets` — execute a Zendesk view and list its tickets (`GET /api/v2/views/{id}/tickets.json`), closing the gap where `list_zendesk_views` advertised finding tickets by view but no tool could run one.

### Changed
- Reworked `README.md` to explain when to choose this local Zendesk connector, what support workflows it helps with, and how it handles customer-authored ticket content.

## [0.3.2] - 2026-05-14
### Added
- **registry**: Cohort B + C backfill — 13 OSS connectors get server.json (12 also get mcpName). google-analytics, hubspot, outreach, quickbooks, salesforce, servicenow, slack, workday, zendesk, office (5-service consolidator), apple-shortcuts, browser-automation, email-imap each gain a registry-shaped server.json validated against registry.modelcontextprotocol.io. mcpName added to 12 of 13 package.json files; browser-automation deferred due to a concurrent agent's uncommitted 0.1.5→0.1.6 version bump in the same file.
- **registry**: cohort review fixes + Office REBEL_OFFICE_* → MCP_OFFICE_* rename + browser-automation mcpName.

### Fixed
- **zendesk**: wrap returned ticket bodies in untrusted-content envelopes (M3.5b)
- **zendesk**: neutralise untrusted-content close-tag breakout (M3-fix-B)
- **ci**: Add npm overrides for fast-uri, hono, ip-address across all connectors.

### Changed
- Republished under the `@mindstone` npm scope. The legacy `@mindstone-engineering/mcp-server-*` package on this version line will be deprecated as part of the FOX-3319 scope migration; see [MIGRATION.md](../../MIGRATION.md) for the procedure consumers should follow.

## [0.3.1] - 2026-04-29

### Fixed
- **zendesk**: Apply cohort sweep — read SERVER_VERSION from package.json (createRequire), add destructiveHint:true to mutating tools, add openWorldHint:true to remote-API tools (false on configure_*). Bump to 0.3.1. Mirrors retell-ai 92c9a40 fix to prevent SERVER_VERSION drift and align tool annotations across the cohort.

### Security
- **deps**: Bump vulnerable transitive deps to patched versions across all connectors. Resolves 52 dependabot moderate-severity alerts (27 hono, 22 postcss, 1 each @hono/node-server, esbuild, uuid).

## [0.3.0] - 2026-04-11

### Added
- **zendesk**: npm publish pipeline — package rename, FSL-1.1-MIT licence, mock test harness, CI. Preparing @mindstone/mcp-server-zendesk for first npm publish.
- **ci**: Add catalog-entry.json manifest and generalise publish workflow. Enables automated catalog sync to MindstoneRebel via repository_dispatch after npm publish.
- **zendesk**: migrate test helpers to shared test-harness

### Fixed
- **ci**: remove --provenance from publish (requires public repo). Bump to rc.2 for retry.
- **ci**: harden publish pipeline — branch guard, triple version sync, Node >=20.
- **zendesk**: migrate remaining local helper imports to shared test-harness
- **bridge**: clean brand references from template and batch1 connectors
- **zendesk**: add bridge env var comment to bridge.ts for scan compatibility

## [0.2.0] - 2026-04-07

### Added
- initial Zendesk connector spike
- **zendesk**: OSS hardening — security fixes, README rewrite, build cleanup.
- **zendesk**: SDK upgrade to McpServer + Zod + ESM npx distribution

### Changed
- Remove all Mindstone/Rebel-specific references from connector source.

### Fixed
- Address review findings — fix gitCommit cwd, NODE_PATH, and remaining Rebel naming.
- Use generic MCP_HOST_BRIDGE_STATE in wiring example for consistency
- Replace misleading standalone env vars with actual accounts.json setup instructions.
