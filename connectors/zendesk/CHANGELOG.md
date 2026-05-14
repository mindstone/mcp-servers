# Changelog

All notable changes to this connector are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The history below `[Unreleased]` was reconstructed from git history during the
`@mindstone-engineering` to `@mindstone` npm scope migration; subsequent entries
are maintained manually as part of the PR review checklist.

## [Unreleased]

### Added
- **registry**: Cohort B + C backfill — 13 OSS connectors get server.json (12 also get mcpName). google-analytics, hubspot, outreach, quickbooks, salesforce, servicenow, slack, workday, zendesk, office (5-service consolidator), apple-shortcuts, browser-automation, email-imap each gain a registry-shaped server.json validated against registry.modelcontextprotocol.io. mcpName added to 12 of 13 package.json files; browser-automation deferred due to a concurrent agent's uncommitted 0.1.5→0.1.6 version bump in the same file.
- **registry**: cohort review fixes + Office REBEL_OFFICE_* → MCP_OFFICE_* rename + browser-automation mcpName.

### Fixed
- **zendesk**: wrap returned ticket bodies in untrusted-content envelopes (M3.5b)
- **zendesk**: neutralise untrusted-content close-tag breakout (M3-fix-B)
- **ci**: Add npm overrides for fast-uri, hono, ip-address across all connectors.

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


