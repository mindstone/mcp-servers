# Changelog

All notable changes to this connector are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The history below `[Unreleased]` was reconstructed from git history during the
`@mindstone-engineering` to `@mindstone` npm scope migration; subsequent entries
are maintained manually as part of the PR review checklist.

## [Unreleased]

### Added
- `list_freshdesk_agents` and `list_freshdesk_groups` tools — discover valid agent and group IDs for the existing `responder_id`/`group_id` assignment parameters on ticket create/update. Names and descriptions are returned inside untrusted-content envelopes.

### Changed
- Ticket subjects are now wrapped in untrusted-content envelopes in every output path (previously only search results wrapped them), and the envelope implementation now delegates to the canonical shared `wrapUntrusted` helper instead of a hand-rolled copy.
- `reply_to_freshdesk_ticket` and `add_freshdesk_note` now declare `destructiveHint: true` — both write to production tickets (public replies are customer-facing).

## [0.2.2] - 2026-05-14
### Added
- **registry**: Cohort A backfill — 12 API-key OSS connectors get server.json + mcpName. fathom, humaans, kling, mixmax, nano-banana, napkin, pandadoc, freshdesk, elevenlabs, retell-ai, runway, talentlms each gain a registry-shaped server.json (validated against registry.modelcontextprotocol.io) and an mcpName field on package.json under the io.github.mindstone namespace.

### Fixed
- **freshdesk**: wrap returned ticket bodies in untrusted-content envelopes (M3.5a)
- **freshdesk**: neutralise untrusted-content close-tag breakout (M3-fix-B)
- **ci**: Add npm overrides for fast-uri, hono, ip-address across all connectors.

### Changed
- Republished under the `@mindstone` npm scope. The legacy `@mindstone-engineering/mcp-server-*` package on this version line will be deprecated as part of the FOX-3319 scope migration; see [MIGRATION.md](../../MIGRATION.md) for the procedure consumers should follow.

## [0.2.1] - 2026-04-29

### Fixed
- **freshdesk**: Apply cohort sweep — read SERVER_VERSION from package.json (createRequire), add destructiveHint:true to mutating tools, add openWorldHint:true to remote-API tools (false on configure_*). Bump to 0.2.1. Mirrors retell-ai 92c9a40 fix to prevent SERVER_VERSION drift and align tool annotations across the cohort.

### Security
- **deps**: Bump vulnerable transitive deps to patched versions across all connectors. Resolves 52 dependabot moderate-severity alerts (27 hono, 22 postcss, 1 each @hono/node-server, esbuild, uuid).

## [0.2.0] - 2026-04-11

### Fixed
- **freshdesk**: add strict subdomain validation to prevent API key exfiltration
- **bridge**: clean brand references from template and batch1 connectors
- **ci**: add npm audit step, fix QBOQL injection, add validateHostname, standardize mock keys

## [0.1.0] - 2026-04-09

### Added
- **freshdesk**: externalize Freshdesk MCP connector to standalone package


