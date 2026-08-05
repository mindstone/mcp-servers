# Changelog

All notable changes to this connector are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The history below `[Unreleased]` was reconstructed from git history during the
`@mindstone-engineering` to `@mindstone` npm scope migration; subsequent entries
are maintained manually as part of the PR review checklist.

## [Unreleased]

### Security

- Wrapped all external, attacker-controllable text returned by HubSpot in `<untrusted-content source="hubspot:…">` envelopes with close-tag breakout escaping (FOX-3490 remediation): CRM record property values, note and engagement bodies, conversation thread messages and original content, knowledge-base article content, form submissions, marketing email subjects, list/workflow/property names and labels, and file metadata. Record IDs, enums, URLs, timestamps, and pagination cursors stay literal so tool round-trips (get-by-ID, pagination, schema-driven writes) keep working. Implemented as a deny-by-default walker (`src/sanitize.ts`) over the vendored envelope helper (`src/untrusted-content.ts`): every string is enveloped unless its key is a recognised structural identifier, so prose fields HubSpot adds in the future are safe by default.

## [0.3.1] - 2026-07-30

### Changed

- Honest multi-cause 403 copy connector-wide with sanitised requiredScopes diagnostics; some 403 error codes normalised (e.g. PERMISSION_DENIED to SCOPE_MISSING)

### Changed

- Extended the honest 403 capability-denied copy across the whole connector — marketing emails, marketing analytics, workflows/automation, the knowledge base, record associations, contacts batch-read, and any generic marketing 403 (previously single-cause "requires Marketing Hub" / "reconnect to refresh scopes" messages that sent users in circles). The message now names all three reasons a capability can be unavailable — the account's plan doesn't include it, the signed-in HubSpot user lacks permission, or (less commonly, since an unauthorised optional scope usually fails the OAuth connect loudly) the app isn't authorised for it — leading with the likelier causes and presenting reconnecting only as the final step once the underlying cause is resolved. Two paths keep a legitimate reconnect-first hybrid because the scope was genuinely added to the app at a known date, so accounts connected earlier really do need to reconnect: HubSpot Lists (`crm.lists.read`) and the conversations tools (`conversations.read`).
- Aligned the model-visible tool descriptions with the same multi-cause wording so the tool contract no longer primes reconnect-first behaviour on a 403: the workflow tools (`list_hubspot_workflows`, `get_hubspot_workflow`, `enrol_in_hubspot_workflow`), the knowledge-base tools (`list_hubspot_kb_articles`, `get_hubspot_kb_article`), and the conversations tools.

### Fixed

- Scope-denied 403s now capture the scope(s) HubSpot names in the error body (`requiredScopes`) into structured error details, so a missing-scope problem is diagnosable from logs instead of guessed. Never fabricates a scope when HubSpot names none. This now covers the association and knowledge-base API-error paths in addition to CRM/files/marketing/workflows.
- Knowledge-base GraphQL failures (which return HTTP 200 with an `errors` array) now classify the cause internally — a missing Service Hub tier versus a missing scope — instead of matching on error-message substrings, so the tier-vs-scope distinction is robust and the scope case gets the honest multi-cause copy rather than reconnect-first advice.

## [0.3.0] - 2026-06-29

### Changed

- Warn on unknown CRM property names with did-you-mean instead of silently dropping them; honest 403 capability-denied copy; hardened atomic credential-write helper.

### Added

- CRM read and search tools now warn when requested properties don't exist on the object type, instead of silently omitting them. The response carries a structured `propertyValidation` field listing the unknown property names and likely-intended matches (a conservative did-you-mean), validated against the object's live property schema. This is a non-fatal warning — the requested data is still returned — and covers all CRM object types (contacts, companies, deals, tickets, leads, products, line items).

### Fixed

- 403 capability-denied errors (e.g. on tickets, properties, and file reads) now return honest, actionable copy instead of advising users to reconnect. The new message explains that reconnecting won't add a capability that isn't available and names who can fix it (a HubSpot administrator, or the account's plan), so users stop looping on ineffective reconnects.

### Security

- Hardened the vendored atomic credential-write helper to match the upstream canonical copy. Added an `assertTargetIsNotSymlink` policy guard that refuses to write when the credential file path is already a symlink (throws `CREDENTIAL_SYMLINK_REJECTED`); this is a fail-loud guard, not a race-free primitive (the exclusive-create temp open plus rename does the real write-through protection). Also synced `string | Buffer` data support, a temp-path `chmod` before rename, and the guarded `O_NOFOLLOW` symlink-refusal open flag.

## [0.2.1] - 2026-05-29

### Changed

- Fix HubSpot search pagination cursor forwarding

## [0.2.0] - 2026-05-21
### Added
- **hubspot**: Conversations Inbox read tools (FOX-3376) — three new read-only tools let agents pull the actual customer messages on a support ticket so they can draft replies:
  - `list_hubspot_ticket_threads(ticketId)` — `GET /conversations/v3/conversations/threads?associatedTicketId={id}`.
  - `list_hubspot_thread_messages(threadId)` — `GET /conversations/v3/conversations/threads/{threadId}/messages`.
  - `get_hubspot_thread_message_original_content(threadId, messageId)` — fetches the full body when a message is truncated.
  - Adds `conversations.read` to the OAuth read-scope tier. **Existing accounts must reconnect to grant the new scope.**
- **hubspot**: `get_hubspot_line_item` now accepts an optional `associations: string[]` argument (FOX-3354). Pass `['deals']` to resolve a line item back to its parent deal in a single call (forwarded to HubSpot as `?associations=deals`). Default behavior is unchanged for callers that don't pass the argument.

### Changed
- **hubspot**: `get_hubspot_associations` (and `create_hubspot_association` / `delete_hubspot_association`) no longer enum-restrict `fromObjectType` / `toObjectType` to `['contacts','companies','deals','tickets','leads']` (FOX-3354). They now accept any HubSpot object type — including `line_items`, `products`, and custom objects — matching the already-permissive `list_hubspot_association_labels`. This unblocks `line_item -> deal` reads for product-level deal reporting.

## [0.1.2] - 2026-05-14
### Security
- **hubspot**: Pre-publish security remediation closing 10 findings (3 CRITICAL, 3 HIGH, 4 MEDIUM) surfaced in the lens-security review. Triple-reviewer + per-stage fix-cycle. See [docs/plans/260512_hubspot_oss_security_remediation.md](../../../../../desktop/MindstoneRebel-1/docs/plans/260512_hubspot_oss_security_remediation.md) in the host repo for the full audit trail.
  - **C1** — `remove_hubspot_account` auth bypass: scope-check enforced before disk mutation.
  - **C2** — LICENSE attribution corrected from "Salesforce MCP Server" to the actual maintainer.
  - **C3** — `sanitizeEmail` collision detection added with new `TokenFileMismatchError`; `(mtimeMs, size)` cache identity prevents race-window reads.
  - **H1** — Raw email PII removed from logs; replaced with HMAC-SHA256 account hashing keyed by `HUBSPOT_TELEMETRY_SALT` (fail-closed `[salt-missing]` sentinel when env is absent).
  - **H2** — Raw HubSpot API error bodies no longer surface in tool responses or logs; new `summariseHubSpotApiError` whitelist projection (`{operation, statusCode, errorCode, category, requestId}`) swept across `crm`, `file`, `workflow`, `association-v4`, `marketing`, and `knowledge-base` handlers. `Retry-After` header surfaced on 429s; AbortError / ENOTFOUND / ECONNREFUSED / ETIMEDOUT / EAI_AGAIN / ECONNRESET now classify to `REQUEST_TIMEOUT` / `NETWORK_ERROR` instead of `UNKNOWN_ERROR`.
  - **H3** — `npm audit --omit=dev --audit-level=high` is now clean: SDK bumped to `^1.29.0` and 4 transitive dependency overrides applied (`fast-uri@^3.1.2`, `hono@^4.12.18`, `express-rate-limit@^8.5.1`, `ip-address@^10.2.0`). Audit gate added to `prepublishOnly`.
  - **M1** — `requiresAuth` dispatcher gate loosened so refresh-failure handlers can return their full agent-recovery shape (`RefreshNoClientCredsError` → `auth_required`).
  - **M2** — `HUBSPOT_CONFIG_DIR` now validated at startup: realpath + symlink walk + protected-path rejection (`/`, `$HOME`, `$TMPDIR`, `$MCP_WORKSPACE_PATH`); Darwin `/var` ↔ `/private/var` alias normalization.
  - **M3** — Refresh lock-stale window bounded `[30s, 900s]` with structured warnings; enterprise-NFS escape hatch raised post fix-cycle.
  - **M4** — Unbounded fan-out closed: `MAX_FAN_OUT=100` and 1 MiB body cap applied across `file` / `workflow` / `crm` handler families; Zod `maxItems` / `maxLength` added to the matching input schemas; `INPUT_TOO_LARGE` errors now carry field paths.

### Added
- New utility module `src/utils/accountHash.ts` (HMAC-SHA256, hex-decoded salt, 64-char digest, byte-equivalent to host implementation).
- New `src/tools/input-limits.ts` providing `MAX_FAN_OUT` and the 1 MiB body-cap helper.
- 78 new tests covering each finding's positive + recovery path (test count: 120 → 198 → 202).

### Changed
- `prepublishOnly` now runs `npm audit --omit=dev --audit-level=high` in addition to build + test + bridge-string check.

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


