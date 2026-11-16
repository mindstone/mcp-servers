# Changelog

All notable changes to `@mindstone/mcp-server-xero` are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Sign in with Xero: a free Xero Web app now works too. With `XERO_REFRESH_TOKEN` set, the server renews its access token itself and hands each new refresh token to Rebel to keep. The new `xero_sign_in` tool signs in (through Rebel) when the keys belong to a Web app, and just checks the connection for a Custom Connection, which keeps working as before.

### Security

- The connector's own sign-in requests (the token grants and the company list) refuse redirects, so a token or the app's keys are never resent to another host. API calls made through xero-node keep its default redirect handling.
- Sign in with Xero opens the browser only when the saved sign-in has expired or been revoked. A rate limit, timeout or Xero outage says to try again, and keys Xero refuses say to check them.

## [0.1.2] - 2026-11-14

### Changed

- Setup errors now name exactly which Xero scopes are missing; envelope helper re-synced.

### Changed

- When Xero refuses the token because the Custom Connection lacks a scope, the error now names exactly the missing scopes instead of listing all 19, by asking Xero for each scope on its own.

### Security

- Re-synced the vendored `<untrusted-content>` envelope helper with the template: slash-delimited envelope tags inside wrapped content are now also neutralised, so they can no longer be read as an envelope boundary.
- The re-synced helper escapes only the start of an embedded envelope tag (`<\untrusted-content`, `<\/untrusted-content`), so wrapping text that holds many unfinished tags no longer takes quadratic time, and unwrapping gives back the original text exactly.

## [0.1.1] - 2026-08-09

### Changed

- Flag all 66 handler error returns with isError across 61 tool files; align package author with the maintained-fork provenance.

### Fixed
- All 66 handler-level error returns across the tool set now set `isError: true` (previously only the factory catch path flagged errors), so clients can reliably distinguish error results from successful text.
- `package.json` `author` now reads `Mindstone <support@mindstone.ai>`, matching the maintained-fork Provenance section in the README.

- Re-synced the vendored `<untrusted-content>` envelope helper with the canonical hardened reference: attribute-bearing close-tag variants (`</untrusted-content foo>`) and spoofed open tags inside wrapped content are now escaped, closing an envelope-breakout gap an LLM parser could read as an envelope boundary.

## [0.1.0] - 2026-08-08

### Changed

- First Mindstone-owned release of the Xero connector (maintained build of Xero's community server): canonical envelopes, expanded bank/budget/report tools, writes enabled by default.

### Added
- New report tools: `list-bank-summary` (per-account balances and movements), `list-budget-summary` (budget vs actuals), and `list-executive-summary` (key financial metrics snapshot). These use the report scopes the connector already requests.
- New `email-invoice` tool that emails a copy of an AUTHORISED invoice to its related contact via Xero.
- New purchase order tools: `list-purchase-orders` (status/date filters, sorting, pagination) and `create-purchase-order` (defaults to DRAFT; optional currency validated against the organisation before any write). Purchase orders are covered by the `accounting.invoices` scope the connector already requests.

### Changed
- Write tools (create/update/delete, history notes, emailing invoices) are enabled by default; the `XERO_ALLOW_WRITES` environment-variable gate has been removed. Write approval is the host application's responsibility (e.g. its tool-approval layer), keeping the connector capability-first.

### Security
- Wrap all tool output text in `<untrusted-content>` envelopes with close-tag breakout escaping, so Xero-authored text (contact names, line item descriptions, history details, validation messages) is presented to the model as data, not instructions.
- Errors thrown from a tool handler now pass through the same `<untrusted-content>` envelope and error formatting as returned results, instead of reaching the model as raw unwrapped text.
- Unknown thrown values are no longer `JSON.stringify`-ed into error messages, so SDK rejections carrying request headers can never leak credentials into model-visible output.

### Fixed
- A failed deep link lookup no longer turns a successful create/update into a tool error; the link is now best-effort and omitted when it cannot be resolved, so the model does not retry (and duplicate) a completed write.
- Report the actual package version in the MCP server metadata instead of a hardcoded `1.0.0`.

## [0.0.17] - 2026-06-09

### Added
- Added a `list-currencies` tool that reports currencies enabled in the connected Xero organisation.

### Fixed
- Validate requested invoice currencies against the connected organisation before creating or updating invoices, so unsupported currencies fail before any invoice write.
- Surface Xero validation errors from SDK responses without exposing token-bearing request headers.

## [0.0.16] - 2026-06-09

### Fixed
- Replaced unavailable legacy Custom Connection scopes (`accounting.transactions` and `accounting.reports.read`) with the granular scopes exposed by Xero's Custom Connection portal.
- Kept token request scope guidance, invalid-scope errors, and setup instructions aligned through a shared scope list.

## [0.0.15] - 2026-06-08

### Added
- Initial Mindstone-scoped Xero connector fork based on the Xero fork lineage through `@harrybloom18/xero-mcp-server@0.0.14-fix.5`.
- Added optional invoice `currencyCode` support for invoice creation and draft invoice updates.
- Preserved invoice attachment tools from the current Rebel-pinned `0.0.14-fix.4` fork.
- Preserved history and note tools from the `0.0.14-fix.5` fork.

### Security
- Format Xero SDK errors using whitelisted fields so token-bearing request headers are not returned to the model.
