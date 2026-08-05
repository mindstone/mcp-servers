# Changelog

All notable changes to this connector are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The history below `[Unreleased]` was reconstructed from git history during the
`@mindstone-engineering` to `@mindstone` npm scope migration; subsequent entries
are maintained manually as part of the PR review checklist.

## [Unreleased]

### Security
- Envelope all external, user-authored text returned by the Outreach API (names, emails, subjects, bodies, notes, tags, custom fields) in `<untrusted-content>` envelopes with close-tag breakout escaping, via the single `formatResource` chokepoint (FOX-3490). Vendor-generated structure (ids, timestamps, lifecycle enums) is left raw; every other attribute is enveloped fail-closed.

### Fixed
- API responses are now Zod-validated against the expected JSON:API envelope structure instead of being blindly cast; a malformed 200 body surfaces a structured `INVALID_RESPONSE` error instead of confusing downstream failures.

## [0.1.3] - 2026-05-14
### Added
- **registry**: Cohort B + C backfill — 13 OSS connectors get server.json (12 also get mcpName). google-analytics, hubspot, outreach, quickbooks, salesforce, servicenow, slack, workday, zendesk, office (5-service consolidator), apple-shortcuts, browser-automation, email-imap each gain a registry-shaped server.json validated against registry.modelcontextprotocol.io. mcpName added to 12 of 13 package.json files; browser-automation deferred due to a concurrent agent's uncommitted 0.1.5→0.1.6 version bump in the same file.

### Fixed
- **outreach**: harden OAuth bind and flip destructiveHint (M3.3)
- **ci**: Add npm overrides for fast-uri, hono, ip-address across all connectors.

### Changed
- Republished under the `@mindstone` npm scope. The legacy `@mindstone-engineering/mcp-server-*` package on this version line will be deprecated as part of the FOX-3319 scope migration; see [MIGRATION.md](../../MIGRATION.md) for the procedure consumers should follow.

## [0.1.2] - 2026-04-29

### Fixed
- **outreach**: Apply cohort sweep — read SERVER_VERSION from package.json (createRequire), add destructiveHint:true to mutating tools, add openWorldHint:true to remote-API tools (false on configure_*). Bump to 0.1.2. Mirrors retell-ai 92c9a40 fix to prevent SERVER_VERSION drift and align tool annotations across the cohort.

## [0.1.1] - 2026-04-29

### Fixed
- **outreach**: Fix input validation and ToolAnnotations. Published v0.1.1.

## [0.1.0] - 2026-04-29

### Added
- **outreach**: Port Outreach MCP connector to OSS npm package.


