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
- **workflows**: ci.yml + apple-shortcuts — add missing connectors to matrix, bump SDK (M1.4)
- **apple-shortcuts**: treat `input` as text, not a path (M3.11)
- **apple-shortcuts**: migrate tests to vitest so the Node 20 CI shard passes. `node --test __tests__/*.test.ts` relied on native TS loading, which is only available in Node 22.6+, breaking apple-shortcuts (20). Aligns with the vitest convention used by every other connector.
- **ci**: Add npm overrides for fast-uri, hono, ip-address across all connectors.

## [0.1.1] - 2026-04-29

### Fixed
- **apple-shortcuts**: Apply cohort sweep — read SERVER_VERSION from package.json (createRequire), add destructiveHint:true to mutating tools, add openWorldHint:true to remote-API tools (false on configure_*). Bump to 0.1.1. Mirrors retell-ai 92c9a40 fix to prevent SERVER_VERSION drift and align tool annotations across the cohort.

## [1.0.0] - 2026-04-24

### Added
- add apple-shortcuts connector (#11)


