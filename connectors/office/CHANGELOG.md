# Changelog

All notable changes to this connector are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The history below `[Unreleased]` was reconstructed from git history during the
`@mindstone-engineering` to `@mindstone` npm scope migration; subsequent entries
are maintained manually as part of the PR review checklist.

## [Unreleased]
### Security
- **sidecar**: Reject unauthenticated requests to `/taskpane.html`, `/taskpane.js`, and `/assets/*` whose `Host` header does not name a loopback host (`localhost`, `127.0.0.1`, or `::1`) on the bound port. The page embeds the WebSocket auth token, so this closes a DNS-rebinding path where a browser tab tricked into resolving an attacker-controlled hostname to 127.0.0.1 could fetch the page cross-origin and exfiltrate the token. Office's manifest only ever uses `localhost:<port>`, so legitimate add-in loads are unaffected.

## [0.1.4] - 2026-05-14
### Fixed
- **ci**: Add npm overrides for fast-uri, hono, ip-address across all connectors.
- **office**: Clear pre-existing high-severity npm audit failure on main.

### Changed
- Republished under the `@mindstone` npm scope. The legacy `@mindstone-engineering/mcp-server-*` package on this version line will be deprecated as part of the FOX-3319 scope migration; see [MIGRATION.md](../../MIGRATION.md) for the procedure consumers should follow.

## [0.1.3] - 2026-05-05

### Added
- **office**: v0.1.3 — security-review preconditions + kill-switch backward compat. Addresses three findings from the Pre-Publish Security Review of v0.1.2 (specialist-security + reviewer-opus4.7-thinking, both PASS_WITH_CONDITIONS) without architectural risk; bumped to 0.1.3 ahead of npm publish.

## [0.1.2] - 2026-05-04

### Added
- **registry**: Cohort B + C backfill — 13 OSS connectors get server.json (12 also get mcpName). google-analytics, hubspot, outreach, quickbooks, salesforce, servicenow, slack, workday, zendesk, office (5-service consolidator), apple-shortcuts, browser-automation, email-imap each gain a registry-shaped server.json validated against registry.modelcontextprotocol.io. mcpName added to 12 of 13 package.json files; browser-automation deferred due to a concurrent agent's uncommitted 0.1.5→0.1.6 version bump in the same file.
- **registry**: cohort review fixes + Office REBEL_OFFICE_* → MCP_OFFICE_* rename + browser-automation mcpName.

### Fixed
- **office**: vi.mock office-addin-dev-certs in test setup
- **office**: scope dev-cert TLS bypass to loopback agent (M3.1)

## [0.1.1] - 2026-04-30

### Fixed
- **office**: address Stage 1 review findings — SECURITY.md, CI matrix, README drift warning, stale paths, zod dep, tarball cleanup
- **office**: Regenerate package-lock.json with full esbuild platform binaries. CI 'npm ci' was failing because the lockfile was missing @esbuild/<platform>@0.28.0 entries for non-darwin platforms.
- **office**: Clarify post-setup instructions — Office desktop apps required + 'Add ons' ribbon location. The previous copy said only 'Home ribbon' which sent users hunting; on current Office builds the Rebel button lives under Home → Add ons.
- **office**: 0.1.1 — pre-create ~/.office-addin-dev-certs in test setup. Workaround for upstream office-addin-dev-certs@2.0.7 calling deleteCertificateFiles() without an ENOENT guard, which crashes the integration suite on fresh CI runners.

### Security
- **deps**: Bump vulnerable transitive deps to patched versions across all connectors. Resolves 52 dependabot moderate-severity alerts (27 hono, 22 postcss, 1 each @hono/node-server, esbuild, uuid).

## [0.1.0] - 2026-04-29

### Added
- **office**: Port Office MCP connector to OSS npm package. Initial 0.1.0 port — lift-and-shift of the stdio MCP server, sidecar, and Office add-in from Mindstone Rebel.


