# Changelog

All notable changes to this connector are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The history below `[Unreleased]` was reconstructed from git history during the
`@mindstone-engineering` to `@mindstone` npm scope migration; subsequent entries
are maintained manually as part of the PR review checklist.

## [Unreleased]

## [0.1.1] - 2026-05-14
### Added
- **hubspot**: Stage 2.5 host-neutrality remediation. Replaces Rebel-branded strings with host-neutral labels and exposes HUBSPOT_SOURCE_LABEL env override.
- **hubspot**: Stage 3 cohort hygiene fixes for v0.1.0. Reads SERVER_VERSION from package.json; adds destructiveHint/openWorldHint sweep; raises request timeout default to 60s with env override.
- **hubspot**: Stage 4 reliability + security hardening for v0.1.0. Adds proper-lockfile credential lock, refresh-failure mapping, schema versioning, and handler-shape correctness across all OAuth-protected tools.
- **registry**: Cohort B + C backfill — 13 OSS connectors get server.json (12 also get mcpName). google-analytics, hubspot, outreach, quickbooks, salesforce, servicenow, slack, workday, zendesk, office (5-service consolidator), apple-shortcuts, browser-automation, email-imap each gain a registry-shaped server.json validated against registry.modelcontextprotocol.io. mcpName added to 12 of 13 package.json files; browser-automation deferred due to a concurrent agent's uncommitted 0.1.5→0.1.6 version bump in the same file.
- **registry**: cohort review fixes + Office REBEL_OFFICE_* → MCP_OFFICE_* rename + browser-automation mcpName.

### Fixed
- **hubspot**: align OSS getScopeTier with host consumer matrix. Reads HUBSPOT_SCOPE_TIER first, then matches HUBSPOT_ACCOUNT_EMAIL in accounts.json instead of falling back to accounts[0].scopeTier.
- **hubspot**: close two silent-failure paths surfaced in Stage 5 round-2 review. getAccounts no longer masks corrupt accounts.json as empty list, and getScopeTier fails closed to readonly instead of silently expanding to full.
- **hubspot**: Address 4 CodeQL findings on PR #22 — GraphQL injection, logger redaction, test-harness sanitization. Three high-severity findings (one real GraphQL string-injection, two CodeQL false positives mitigated structurally) plus one medium-severity test-fixture stack-trace exposure.

### Changed
- Republished under the `@mindstone` npm scope. The legacy `@mindstone-engineering/mcp-server-*` package on this version line will be deprecated as part of the FOX-3319 scope migration; see [MIGRATION.md](../../MIGRATION.md) for the procedure consumers should follow.

## [0.1.0] - 2026-05-04

### Added
- **hubspot**: Initial HubSpot MCP connector v0.1.0 — second OAuth connector externalization. Ports bundled HubSpot source to OSS package without callback server (host-orchestrated bridge mode); inherits Slack v0.1.0 patterns.


