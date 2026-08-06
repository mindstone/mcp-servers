# Changelog

All notable changes to this connector are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The history below `[Unreleased]` was reconstructed from git history during the
`@mindstone-engineering` to `@mindstone` npm scope migration; subsequent entries
are maintained manually as part of the PR review checklist.

## [Unreleased]

### Added
- `update_servicenow_incident` now accepts `work_notes` and `comments`, so notes can be appended to an incident's journal — previously there was no way to add a note or comment to an incident.
- New tool: `create_servicenow_change_request` — create a change request (short_description, description, type, assignment_group, category, risk), symmetric with `create_servicenow_incident`. Marked `destructiveHint: true`.
- New tools: `list_servicenow_catalog_items` and `get_servicenow_catalog_item` — read-only access to the service catalog (sc_cat_item) so self-service items are discoverable.
- OAuth 2.0 client credentials authentication (`SERVICENOW_CLIENT_ID` / `SERVICENOW_CLIENT_SECRET`) as an alternative to basic auth, for instances that enforce MFA/SSO. Tokens are fetched from the instance's `oauth_token.do` endpoint and cached until shortly before expiry; basic auth still takes precedence when both are configured.

### Security
- All external text returned by ServiceNow (incident/change-request/knowledge/user records, including fields added by instance customisation) is now wrapped in `<untrusted-content>` envelopes with close-tag breakout escaping, per the repo's untrusted-content invariant. Identifiers, timestamps, and choice-list display values stay literal so they can be copied into follow-up tool calls.
- Close-tag breakout escaping now neutralises every whitespace variant (`</untrusted-content\n>`, `\r\n`, form feed, etc.), matching the canonical strong envelope helper — previously only spaces and tabs were escaped.
- Vendor API error messages and bodies are now enveloped (and length-bounded) before reaching model-visible output, and a malformed successful JSON body no longer leaks parser messages that can embed body fragments.
- The vendor error path tolerates hostile error bodies: a non-string `error.message` / `error.detail` no longer crashes into the generic error handler — the stringified body is enveloped instead. The instance-authored `Content-Type` header in a non-JSON response error is now enveloped too.
- Values under "structural" keys (state, priority, type, …) must now match a conservative printable-character shape to stay literal; a hostile instance-customised display value fails safe into an envelope instead of being trusted by key name alone.
- The host bridge state file is now opened once and read through its file descriptor (no check-then-use window), refuses symlinks / non-regular files / oversized files, and is Zod-validated — the port must be an integer in 1–65535, so a crafted state file can no longer re-interpret the request URL authority and exfiltrate the bridge bearer token. Rejections are logged to stderr instead of being silently swallowed. Bridge responses are Zod-validated before use.
- Write-tool choice parameters are now real enums (`type`, `risk`, `state`, `urgency`, `impact`) and list pagination is bounded (integer limit 1–1000, non-negative offset), so invalid values are rejected before any network call.

### Fixed
- The ServiceNow mock server in tests now honours `sysparm_limit` / `sysparm_offset`, so pagination tests exercise real page boundaries.

## [0.2.2] - 2026-05-14
### Added
- **registry**: Cohort B + C backfill — 13 OSS connectors get server.json (12 also get mcpName). google-analytics, hubspot, outreach, quickbooks, salesforce, servicenow, slack, workday, zendesk, office (5-service consolidator), apple-shortcuts, browser-automation, email-imap each gain a registry-shaped server.json validated against registry.modelcontextprotocol.io. mcpName added to 12 of 13 package.json files; browser-automation deferred due to a concurrent agent's uncommitted 0.1.5→0.1.6 version bump in the same file.

### Fixed
- **ci**: Add npm overrides for fast-uri, hono, ip-address across all connectors.

### Changed
- Republished under the `@mindstone` npm scope. The legacy `@mindstone-engineering/mcp-server-*` package on this version line will be deprecated as part of the FOX-3319 scope migration; see [MIGRATION.md](../../MIGRATION.md) for the procedure consumers should follow.

## [0.2.1] - 2026-04-29

### Fixed
- **servicenow**: Apply cohort sweep — read SERVER_VERSION from package.json (createRequire), add destructiveHint:true to mutating tools, add openWorldHint:true to remote-API tools (false on configure_*). Bump to 0.2.1. Mirrors retell-ai 92c9a40 fix to prevent SERVER_VERSION drift and align tool annotations across the cohort.

### Security
- **deps**: Bump vulnerable transitive deps to patched versions across all connectors. Resolves 52 dependabot moderate-severity alerts (27 hono, 22 postcss, 1 each @hono/node-server, esbuild, uuid).

## [0.2.0] - 2026-04-11

### Fixed
- **batch1**: fix 5 blocking scrutiny issues from batch-1 review
- **batch1**: bridge error propagation for Fathom/Mixmax/PandaDoc + Zod-before-outbound proof for all 6
- **bridge**: clean brand references from template and batch1 connectors

## [0.1.0] - 2026-04-09

### Added
- **servicenow**: externalize ServiceNow MCP connector to standalone package


