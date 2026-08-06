# Changelog

All notable changes to this connector are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The history below `[Unreleased]` was reconstructed from git history during the
`@mindstone-engineering` to `@mindstone` npm scope migration; subsequent entries
are maintained manually as part of the PR review checklist.

## [Unreleased]

### Added
- `get_quickbooks_report` — financial reports (ProfitAndLoss, BalanceSheet, CashFlow, AgedReceivables, AgedPayables) from the dedicated `/reports` endpoint, which `query_quickbooks` cannot reach. Date-range reports take `startDate`/`endDate`, aging reports take `asOfDate`, and `accountingMethod` is optional.
- `send_quickbooks_invoice_email` — email an invoice to its customer (optional `sendTo` override). Gated behind `QB_ALLOW_PROD_WRITES=1` with `destructiveHint`, since it emails a real customer.
- `download_quickbooks_invoice_pdf` — download an invoice as a PDF, saved to the system temp directory.
- `list_quickbooks_estimates` / `create_quickbooks_estimate` — estimates (quotes), previously reachable only through raw `query_quickbooks`.
- `update_quickbooks_invoice` / `update_quickbooks_customer` / `update_quickbooks_vendor` — sparse updates. When `syncToken` is omitted the entity is read first (QuickBooks rejects stale SyncTokens). Customer/vendor updates can deactivate via `active: false`. All gated behind `QB_ALLOW_PROD_WRITES=1`.

### Security
- QuickBooks-authored free text (display names, memos, line descriptions, report cells) is now wrapped in `<untrusted-content>` envelopes before reaching the model (FOX-3490 remediation). Typed entity payloads envelope the known free-text fields; `query_quickbooks`, `get_quickbooks_entity`, and reports envelope every string value wholesale.
- `download_quickbooks_invoice_pdf` no longer writes to a predictable temp path with an unconditional `writeFileSync` (which followed pre-existing symlinks and silently overwrote existing files). Downloads land in a fresh `mkdtempSync` staging directory (mode 0700) under the canonical temp root, opened `O_CREAT|O_EXCL` (mode 0600), fstat-verified, and written through the single descriptor.
- Vendor error text (QuickBooks `Fault` Detail/Message) and Intuit OAuth error descriptions are enveloped in `<untrusted-content>` before they can reach model output, so a compromised API/OAuth response cannot inject instructions or break out of the surrounding envelope.
- Typed entity payloads (`sanitizeQboEntity`) are now sanitized deny-by-default: every string is enveloped unless its key is a narrow structural predicate (IDs, SyncToken, `*Ref.value` markers, enums, dates/timestamps). This closes the allow-list gaps that left `PrimaryEmailAddr.Address`, `PrimaryPhone.FreeFormNumber`, postal-address fields, and any future vendor-defined free-text fields unwrapped.
- Structural values are no longer trusted by key name alone: a value under a structural key (`Id`, `SyncToken`, `TxnDate`, …) that fails a shape check (short punctuation tokens only) is enveloped like free text, so a compromised API cannot smuggle prose or a close-tag breakout past the structural allow-list.
- A 2xx response with a non-JSON body (API or OAuth token endpoint) no longer propagates the runtime's JSON parse error — whose message embeds a snippet of the vendor-controlled body — to model output. The connector now returns a static `INVALID_RESPONSE` / `AUTH_FAILED` error instead.

### Changed
- QuickBooks `minorversion` is centralized in one constant and bumped from 65 to 75 (was hardcoded at every call site).
- The `User-Agent` header now tracks `package.json` instead of being pinned to a stale version.

### Fixed
- `server.json` now declares the optional `MCP_HOST_BRIDGE_STATE` / `MINDSTONE_REBEL_BRIDGE_STATE` bridge variables that `src/bridge.ts` reads.
- Write-tool input validation is hardened: dates (`dueDate`, `expirationDate`, report `startDate`/`endDate`/`asOfDate`) must be real YYYY-MM-DD calendar dates, line arrays must be non-empty with finite positive amounts (and positive quantities where applicable), customer/vendor email fields must be valid emails, and `customerId`/`itemId`/`vendorId`/`accountId` on the create tools are alphanumeric-validated before any outbound request.
- List tools (`list_quickbooks_*` and `query_quickbooks`) no longer silently return a truncated first page: output now includes `hasMore` (computed exactly via a one-row probe, not a count-equals-limit guess) plus a `note` with recovery guidance when results were truncated.
- `hasMore` no longer silently degrades to always-false at `limit: 1000`: Intuit caps MAXRESULTS at 1000, so the one-row probe is suppressed at the cap and a full-page heuristic is used there instead.
- `limit` on the list/query tools must now be a positive integer (`limit: 0` and `limit: 1.5` are rejected before any outbound request instead of producing an empty page or a server-side error).

## [0.3.1] - 2026-05-14
### Added
- **registry**: Cohort B + C backfill — 13 OSS connectors get server.json (12 also get mcpName). google-analytics, hubspot, outreach, quickbooks, salesforce, servicenow, slack, workday, zendesk, office (5-service consolidator), apple-shortcuts, browser-automation, email-imap each gain a registry-shaped server.json validated against registry.modelcontextprotocol.io. mcpName added to 12 of 13 package.json files; browser-automation deferred due to a concurrent agent's uncommitted 0.1.5→0.1.6 version bump in the same file.

### Fixed
- **ci**: Add npm overrides for fast-uri, hono, ip-address across all connectors.

### Changed
- Republished under the `@mindstone` npm scope. The legacy `@mindstone-engineering/mcp-server-*` package on this version line will be deprecated as part of the FOX-3319 scope migration; see [MIGRATION.md](../../MIGRATION.md) for the procedure consumers should follow.

## [0.3.0] - 2026-05-01

### Fixed
- **quickbooks**: gate production writes behind QB_ALLOW_PROD_WRITES=1 (M3.13)

## [0.2.1] - 2026-04-29

### Fixed
- **quickbooks**: Apply cohort sweep — read SERVER_VERSION from package.json (createRequire), add destructiveHint:true to mutating tools, add openWorldHint:true to remote-API tools (false on configure_*). Bump to 0.2.1. Mirrors retell-ai 92c9a40 fix to prevent SERVER_VERSION drift and align tool annotations across the cohort.

### Security
- **deps**: Bump vulnerable transitive deps to patched versions across all connectors. Resolves 52 dependabot moderate-severity alerts (27 hono, 22 postcss, 1 each @hono/node-server, esbuild, uuid).

## [0.2.0] - 2026-04-11

### Fixed
- **batch3**: fix 4 blocking scrutiny issues for runway, workday, quickbooks
- **bridge**: clean brand references from template and batch1 connectors
- **ci**: add npm audit step, fix QBOQL injection, add validateHostname, standardize mock keys

## [0.1.0] - 2026-04-09

### Added
- **quickbooks**: externalize QuickBooks MCP connector to standalone package


