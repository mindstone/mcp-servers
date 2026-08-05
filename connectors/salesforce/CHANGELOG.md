# Changelog

All notable changes to this connector are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The history below `[Unreleased]` was reconstructed from git history during the
`@mindstone-engineering` to `@mindstone` npm scope migration; subsequent entries
are maintained manually as part of the PR review checklist.

## [Unreleased]

### Added

- New Case tools: `salesforce_get_cases`, `salesforce_create_case`, `salesforce_update_case` for support/customer-success workflows.
- New Event tools: `salesforce_get_events`, `salesforce_create_event` for calendar/meeting-prep workflows. Date filters accept plain dates or ISO 8601 datetimes.
- New `salesforce_search` tool: cross-object full-text search (SOSL) across Account, Contact, Lead, Opportunity, Case, Task, and Event. Search terms are escaped against SOSL reserved characters.

### Security

- Envelope every record field returned by `salesforce_query`, `salesforce_get_records`, and all `salesforce_get_*` tools in `<untrusted-content>` tags so org-authored text (names, emails, descriptions, subjects) is treated as data, not instructions (FOX-3490). Record IDs stay raw so they can be reused in follow-up calls. Org-authored labels in `salesforce_describe_object` and `salesforce_list_objects` are enveloped too.

## [0.1.3] - 2026-06-12

### Changed

- Bridge mode: attach the jsforce refresh token only when OAuth2 client info is present so the connection no longer throws at construction; degrade to SESSION_EXPIRED on token expiry.

### Fixed
- **salesforce**: bridge-mode tool calls no longer fail with `Refresh token is specified without oauth2 client information or refresh function`. The connector only hands jsforce a refresh token when it also has the OAuth2 client info to use it; in bridge mode (host owns OAuth, no `SALESFORCE_CLIENT_ID`/`SALESFORCE_CLIENT_SECRET` in the connector env) it now operates on the access token and surfaces a reconnect prompt on expiry instead of throwing on every call.

### Changed
- Reworked `README.md` to explain when to choose this local Salesforce connector, what sales workflows it helps with, and the main setup and safety notes.

## [0.1.2] - 2026-05-14
### Added
- **registry**: Cohort B + C backfill — 13 OSS connectors get server.json (12 also get mcpName). google-analytics, hubspot, outreach, quickbooks, salesforce, servicenow, slack, workday, zendesk, office (5-service consolidator), apple-shortcuts, browser-automation, email-imap each gain a registry-shaped server.json validated against registry.modelcontextprotocol.io. mcpName added to 12 of 13 package.json files; browser-automation deferred due to a concurrent agent's uncommitted 0.1.5→0.1.6 version bump in the same file.
- **registry**: cohort review fixes + Office REBEL_OFFICE_* → MCP_OFFICE_* rename + browser-automation mcpName.

### Fixed
- **salesforce**: salesforce_update_contact targets Contact, not Account (M2.7)
- **salesforce**: replace [Connector Name] placeholder in LICENSE with Salesforce MCP Server (M2.8)
- **salesforce**: harden SOQL escaping and OAuth bind (M3.2)
- **salesforce**: make SOQL comment-stripping quote-aware (M3-fix-A)
- **ci**: Add npm overrides for fast-uri, hono, ip-address across all connectors.

### Changed
- Republished under the `@mindstone` npm scope. The legacy `@mindstone-engineering/mcp-server-*` package on this version line will be deprecated as part of the FOX-3319 scope migration; see [MIGRATION.md](../../MIGRATION.md) for the procedure consumers should follow.

## [0.1.1] - 2026-04-29

### Fixed
- **salesforce**: Apply cohort sweep — read SERVER_VERSION from package.json (createRequire), add destructiveHint:true to mutating tools, add openWorldHint:true to remote-API tools (false on configure_*). Bump to 0.1.1. Mirrors retell-ai 92c9a40 fix to prevent SERVER_VERSION drift and align tool annotations across the cohort.

### Security
- **deps**: Bump vulnerable transitive deps to patched versions across all connectors. Resolves 52 dependabot moderate-severity alerts (27 hono, 22 postcss, 1 each @hono/node-server, esbuild, uuid).

## [0.1.0] - 2026-04-29

### Added
- **salesforce**: Port Salesforce MCP connector to OSS npm package.
