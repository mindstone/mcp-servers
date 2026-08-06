# Changelog

All notable changes to this connector are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The history below `[Unreleased]` was reconstructed from git history during the
`@mindstone-engineering` to `@mindstone` npm scope migration; subsequent entries
are maintained manually as part of the PR review checklist.

## [Unreleased]

## [0.2.0] - 2026-08-08

### Changed

- Outreach connector: canonical result envelopes, untrusted-content fencing, scope widening; expanded prospect/sequence actions.

### Added
- `outreach_list_sequence_steps` — list a sequence's steps (type, interval, order, linked template IDs).
- `outreach_get_sequence_template` — read a sequence template including the resolved email `subject`/`bodyHtml`, unlocking sequence-copy review and drafting workflows.
- `outreach_remove_prospect_from_sequence` — pause (default, reversible) or finish a prospect's sequence enrollment, closing the one-way-enrollment compliance gap. Flagged `destructiveHint: true` so hosts gate it behind user confirmation.
- `outreach_create_prospect` / `outreach_update_prospect` now accept a `custom_fields` object mapped to Outreach's `custom1`..`custom35` prospect attributes, with out-of-range keys rejected up front.
- `outreach_create_task` — create a task (note, optional action type, due date, prospect, owner).
- `outreach_complete_task` — mark a task completed (`destructiveHint: true`, matching the connector's mutate-existing-record convention).
- `outreach_list_calls` — list calls with direction, outcome, notes, and linked call-disposition ID, filterable by prospect or user.
- `outreach_list_mailboxes` — list connected sender mailboxes, feeding the `mailbox_id` parameter on `outreach_add_prospect_to_sequence`.

### Security
- Envelope all external, user-authored text returned by the Outreach API (names, emails, subjects, bodies, notes, tags, custom fields) in `<untrusted-content>` envelopes with close-tag breakout escaping, via the single `formatResource` chokepoint (FOX-3490). Vendor-generated structure (ids, timestamps, lifecycle enums) is left raw; every other attribute is enveloped fail-closed.
- Vendor error text — API error details (including raw non-JSON response bodies) and OAuth token-exchange failure bodies — is now truncated to 500 characters and wrapped in `<untrusted-content source="outreach:api-error">` envelopes before it can reach model context.
- Outreach resource IDs accepted by tools must now be numeric (`/^\d+$/`); non-numeric values are rejected before any API request, closing path-traversal steering of request URLs. A non-numeric template reference in a vendor response likewise fails closed with `INVALID_RESPONSE` instead of steering the follow-up request. The same contract now applies to the sequence-state ID returned by the vendor in `outreach_remove_prospect_from_sequence`, which steers a state-changing POST.
- The host bridge state file is now Zod-validated (integer port 1–65535, non-empty token); malformed state is ignored instead of being interpolated into the bridge URL.
- The standalone-OAuth callback now validates the CSRF `state` parameter before acting on an OAuth `error` parameter, and the `error` parameter — plus token-exchange error messages that can embed vendor response text (e.g. a non-JSON token-endpoint body inside Node's parse error) — is truncated to 500 characters and wrapped in `<untrusted-content source="outreach:api-error">` envelopes before it can reach model context.
- The vendored untrusted-content helper is re-synced byte-for-byte with the canonical reference: nested object keys inside API attribute values are now enveloped alongside their values (previously keys passed through raw, contradicting the file's own sync claim).

### Fixed
- `outreach_remove_prospect_from_sequence` now acts on the live (non-finished) sequence state for the prospect+sequence pair. Previously it acted on the first record returned — for a re-enrolled prospect that could pause a finished no-op record and report success while the live enrollment kept sending. Several live states fail closed with `AMBIGUOUS_STATE`; all-finished returns `NOT_FOUND`.
- List tools now report `count` as the number of records returned when the API omits `meta.count` (previously reported `0` next to a populated `records` array).
- API responses are now Zod-validated against the expected JSON:API envelope structure instead of being blindly cast; a malformed 200 body surfaces a structured `INVALID_RESPONSE` error instead of confusing downstream failures.
- `outreach_list_tasks` now filters on the API's actual task `state` attribute (`filter[state]`, values `incomplete`/`completed`); the previous `filter[status]` matched nothing, so status filtering silently returned unfiltered results.
- `page_offset` parameter descriptions now state that the value is a record offset (the API's `page[offset]`), not a page index.
- The host bridge state file now also accepts `port` as a numeric string (coerced, then integer/range-checked as before), so a host-side serialisation change from number to string no longer silently degrades the connector to "Bridge not available". Non-numeric strings are still rejected.

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


