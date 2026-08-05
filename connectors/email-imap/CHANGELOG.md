# Changelog

All notable changes to this connector are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The history below `[Unreleased]` was reconstructed from git history during the
`@mindstone-engineering` to `@mindstone` npm scope migration; subsequent entries
are maintained manually as part of the PR review checklist.

## [Unreleased]

### Added
- **email-imap**: `email_search_messages` gains `before_uid` cursor pagination (responses now return `hasMore` + `nextBeforeUid` when older pages exist) and `since`/`before` date filters — older history in busy inboxes is now reachable.
- **email-imap**: new `email_delete` tool — moves messages to the account's Trash mailbox when one exists, otherwise marks `\Deleted` and expunges permanently; annotated `destructiveHint: true`.
- **email-imap**: new `email_get_attachment` tool — downloads MIME attachment parts into an `email-imap-attachments/` directory inside the `MCP_WORKSPACE_PATH` workspace root (or the system temp directory), with sanitized filenames, symlink-safe containment, and a 50 MB per-attachment cap. Attachment metadata from `email_get_message` now includes the `part` identifier this tool consumes.
- **email-imap**: draft management — new `email_list_drafts`, `email_update_draft` (append-first replace), and `email_delete_draft` (permanent; `destructiveHint: true`) tools alongside the existing `email_save_draft`.
- **email-imap**: outbound attachments on `email_send`, `email_save_draft`, and `email_update_draft` — files are read only from inside the workspace sandbox (max 10 files / 25 MB total per message).
- **email-imap**: mailbox management — new `email_create_mailbox`, `email_rename_mailbox`, and `email_delete_mailbox` (`destructiveHint: true`) tools; INBOX is refused for all three.

### Security
- **email-imap**: subject, from/to display names, and attachment filenames returned by `email_get_message`, `email_search_messages`, and `email_get_mailbox_status` are now wrapped in `<untrusted-content source="external-email">` envelopes (previously only message bodies were enveloped), closing the attacker-controlled-header injection gap. The connector's hand-rolled body wrapper was replaced by the canonical vendored `untrusted-content` helper.

## [0.2.3] - 2026-05-14
### Added
- **registry**: Cohort B + C backfill — 13 OSS connectors get server.json (12 also get mcpName). google-analytics, hubspot, outreach, quickbooks, salesforce, servicenow, slack, workday, zendesk, office (5-service consolidator), apple-shortcuts, browser-automation, email-imap each gain a registry-shaped server.json validated against registry.modelcontextprotocol.io. mcpName added to 12 of 13 package.json files; browser-automation deferred due to a concurrent agent's uncommitted 0.1.5→0.1.6 version bump in the same file.
- **registry**: cohort review fixes + Office REBEL_OFFICE_* → MCP_OFFICE_* rename + browser-automation mcpName.

### Fixed
- **email-imap**: harden email_send with destructiveHint, recipient cap, and rate limit (M2.5)
- **email-imap**: wrap email_get_message bodies in untrusted-content envelope (M2.6)
- **email-imap**: count comma-separated addresses in email_send recipient cap (M2-fix-3)
- **email-imap**: drive email_get_message htmlBody presence by MIME, not truthiness (M2-fix-4)
- **email-imap**: provider auto-detect + custom-TLS enforcement (M3.4)
- **email-imap**: close configure_email_imap silent-iCloud parity gap (M3.4b)
- **email-imap**: neutralise untrusted-content close-tag breakout (M3-fix-B)
- **ci**: Add npm overrides for fast-uri, hono, ip-address across all connectors.

### Changed
- Republished under the `@mindstone` npm scope. The legacy `@mindstone-engineering/mcp-server-*` package on this version line will be deprecated as part of the FOX-3319 scope migration; see [MIGRATION.md](../../MIGRATION.md) for the procedure consumers should follow.

## [0.2.2] - 2026-04-29

### Fixed
- **email-imap**: Apply cohort sweep — read SERVER_VERSION from package.json (createRequire), add destructiveHint:true to mutating tools, add openWorldHint:true to remote-API tools (false on configure_*). Bump to 0.2.2. Mirrors retell-ai 92c9a40 fix to prevent SERVER_VERSION drift and align tool annotations across the cohort.

### Security
- **deps**: Bump vulnerable transitive deps to patched versions across all connectors. Resolves 52 dependabot moderate-severity alerts (27 hono, 22 postcss, 1 each @hono/node-server, esbuild, uuid).

## [0.2.1] - 2026-04-14

### Fixed
- **email-imap**: Upgrade nodemailer from ^6.9.0 to ^8.0.5 to fix high-severity vulnerabilities. Resolves GHSA-mm7p-fcc7-pg87, GHSA-rcmh-qjqh-p98v, GHSA-c7w3-x93f-qmm8, GHSA-vvjj-xcjg-gr5g (all nodemailer <=8.0.4).

## [0.2.0] - 2026-04-11

### Fixed
- **bridge**: clean brand references from template and batch1 connectors

## [0.1.0] - 2026-04-10

### Added
- **email-imap**: externalize Email-IMAP MCP connector to standalone package


