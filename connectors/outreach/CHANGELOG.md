# Changelog

All notable changes to this connector are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The history below `[Unreleased]` was reconstructed from git history during the
`@mindstone-engineering` to `@mindstone` npm scope migration; subsequent entries
are maintained manually as part of the PR review checklist.

## [Unreleased]

### Added
- `outreach_list_sequence_steps` — list a sequence's steps (type, interval, order, linked template IDs).
- `outreach_get_sequence_template` — read a sequence template including the resolved email `subject`/`bodyHtml`, unlocking sequence-copy review and drafting workflows.
- `outreach_remove_prospect_from_sequence` — pause (default, reversible) or finish a prospect's sequence enrollment, closing the one-way-enrollment compliance gap. Flagged `destructiveHint: true` so hosts gate it behind user confirmation.
- `outreach_create_prospect` / `outreach_update_prospect` now accept a `custom_fields` object mapped to Outreach's `custom1`..`custom35` prospect attributes, with out-of-range keys rejected up front.
- `outreach_create_task` — create a task (note, optional action type, due date, prospect, owner).
- `outreach_complete_task` — mark a task completed (`destructiveHint: true`, matching the connector's mutate-existing-record convention).
- `outreach_list_calls` — list calls with direction, outcome, notes, and linked call-disposition ID, filterable by prospect or user.

### Security
- Envelope all external, user-authored text returned by the Outreach API (names, emails, subjects, bodies, notes, tags, custom fields) in `<untrusted-content>` envelopes with close-tag breakout escaping, via the single `formatResource` chokepoint (FOX-3490). Vendor-generated structure (ids, timestamps, lifecycle enums) is left raw; every other attribute is enveloped fail-closed.

### Fixed
- API responses are now Zod-validated against the expected JSON:API envelope structure instead of being blindly cast; a malformed 200 body surfaces a structured `INVALID_RESPONSE` error instead of confusing downstream failures.
- `outreach_list_tasks` now filters on the API's actual task `state` attribute (`filter[state]`, values `incomplete`/`completed`); the previous `filter[status]` matched nothing, so status filtering silently returned unfiltered results.

### Changed
- The default OAuth scope set (`OUTREACH_OAUTH_SCOPES` fallback) now also requests `sequenceStates.all`, `sequenceSteps.read`, `sequenceTemplates.read`, `templates.read`, `calls.read`, and `mailboxes.read`, covering the new sequence-content, enrollment-management, calls, and mailboxes tools — and fixing the sequence-enroll tool's previously undeclared `sequenceStates` scope. Accounts connected before this change need to re-run `outreach_connect_account` to pick up the new scopes.

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


