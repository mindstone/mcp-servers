# Changelog

All notable changes to this connector are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The history below `[Unreleased]` was reconstructed from git history during the
`@mindstone-engineering` to `@mindstone` npm scope migration; subsequent entries
are maintained manually as part of the PR review checklist.

## [Unreleased]

## [0.3.0] - 2026-08-07

### Changed

- Workday connector: canonical result envelopes, untrusted-content fencing, honest client-side search; expanded org/people actions.

### Added
- **tools**: `list_workday_direct_reports` — list a worker's direct reports (`GET /workers/{id}/directReports`), enabling org-chart questions.
- **tools**: `list_workday_time_off` — list a worker's time-off entries from the `absenceManagement/v1` service family; comment/reason free-text fields are excluded from the response.
- **tools**: `list_workday_job_requisitions` — list open roles from the recruiting REST family. The recruiting family version defaults to `v41.2` and is overridable via the new optional `WORKDAY_RECRUITING_API_VERSION` env var (Workday versions this API by platform release).
- **tools**: `list_workday_locations` and `list_workday_jobs` — work locations (core v1 surface) and worker job assignments (`payroll/v2` family).

### Fixed
- **search**: `list_workday_workers`' `search` argument was forwarded to `/workers` as a query param, but the collection documents only `limit`/`offset` — the term was silently ignored. Search now filters client-side (case-insensitive match on name, email, title) over paged results, bounded to 1000 scanned workers, and reports the scan window in the response.
- **metadata**: User-Agent is derived from `package.json` (was hardcoded to 0.1.0); `server.json` no longer marks `WORKDAY_REFRESH_TOKEN` as required, matching the auth model (client_credentials grant when absent).
- **pagination**: `limit`/`offset` now require integers in range (`limit` 1-100, `offset` >= 0) and malformed values are rejected instead of silently clamped; `worker_id` arguments must be non-blank. Vendor-reported totals of `0` are no longer rewritten to the page size.

### Security
- **untrusted content**: object keys inside vendor-shaped response values are now enveloped too. The vendored `wrapUntrustedJsonStrings` matched the canonical helper for values but left keys raw, so a hostile tenant returning a normally-scalar field as an object (e.g. `{"descriptor": {"</untrusted-content>…": 1}}`) could smuggle unenveloped text — including a live close-tag breakout — through a key. Keys are now wrapped recursively, matching the shared reference helper.
- **SSRF hardening**: host validation now also rejects an explicit scheme-default port (`host:443`) — WHATWG URL parsing normalizes it away, so the previous port check could not see it.
- **bridge**: the host-bridge response body is now shape-validated (Zod) — a malformed or non-JSON bridge response fails closed with a connector-authored message — and bridge-authored `error`/`warning` strings are wrapped in `<untrusted-content source="workday-bridge">` envelopes before reaching model-visible output, closing the last non-connector-authored text surface in tool results.
- **token handling**: OAuth token responses are now validated (Zod) before caching — a malformed body or an out-of-bounds `expires_in` (accepted range 60s-24h) is refused with a bounded error instead of pinning the cached token open or crashing on a missing `access_token`. Applies to both the token exchange and `configure_workday_credentials`.
- **untrusted content**: the envelope decision in `pickFields` is now a deny-list instead of a field-name allowlist — every string in an allowlisted value (including structured strings like dates and values the vendor returns in an unexpected shape, e.g. an array or object where a scalar was expected) is wrapped in `<untrusted-content source="workday">`, recursively. Only the identity fields `id`/`href` stay raw, so adding a field to an allowlist can never silently create an unenveloped text surface.
- **untrusted content**: Workday-authored text fields (descriptors, titles, emails, statuses, nested reference descriptors) and the echoed search query are now wrapped in `<untrusted-content source="workday">` envelopes with close-tag breakout escaping, so a Workday user who controls such a field cannot inject model instructions into tool output. Identity fields (`id`, `href`) stay raw so the model can round-trip them into later tool calls.
- **error sanitization**: vendor/proxy-controlled error bodies (OAuth `error_description`, JSON error fields, raw text) are no longer propagated into model-visible errors; all API/token errors are bounded, connector-authored messages keyed on status code, and arbitrary thrown error messages are logged to stderr instead of returned.
- **SSRF hardening**: all fetches run with `redirect: 'manual'` and 3xx responses fail closed, so a redirect can never replay the Basic credential or bearer token to an arbitrary host. Host validation now rejects non-canonical IPv4 spellings (short/hex/octal/integer forms), IPv6 loopback/link-local/unique-local/IPv4-mapped literals, ports, and embedded user-info, and a fail-closed DNS re-resolution guard re-checks every A/AAAA record against the non-public range deny list before any credential-bearing request.
- **bridge state**: the host-supplied bridge-state file read is hardened — absolute/traversal-free path required, open-once + fstat + read-through-fd, 64 KiB size cap, strict JSON shape validation (integer port, non-empty token), and every failure logs an explicit stderr warning instead of silently collapsing.

## [0.2.2] - 2026-05-14
### Added
- **registry**: Cohort B + C backfill — 13 OSS connectors get server.json (12 also get mcpName). google-analytics, hubspot, outreach, quickbooks, salesforce, servicenow, slack, workday, zendesk, office (5-service consolidator), apple-shortcuts, browser-automation, email-imap each gain a registry-shaped server.json validated against registry.modelcontextprotocol.io. mcpName added to 12 of 13 package.json files; browser-automation deferred due to a concurrent agent's uncommitted 0.1.5→0.1.6 version bump in the same file.

### Fixed
- **ci**: Add npm overrides for fast-uri, hono, ip-address across all connectors.

### Changed
- Republished under the `@mindstone` npm scope. The legacy `@mindstone-engineering/mcp-server-*` package on this version line will be deprecated as part of the FOX-3319 scope migration; see [MIGRATION.md](../../MIGRATION.md) for the procedure consumers should follow.

## [0.2.1] - 2026-04-29

### Fixed
- **workday**: Apply cohort sweep — read SERVER_VERSION from package.json (createRequire), add destructiveHint:true to mutating tools, add openWorldHint:true to remote-API tools (false on configure_*). Bump to 0.2.1. Mirrors retell-ai 92c9a40 fix to prevent SERVER_VERSION drift and align tool annotations across the cohort.

### Security
- **deps**: Bump vulnerable transitive deps to patched versions across all connectors. Resolves 52 dependabot moderate-severity alerts (27 hono, 22 postcss, 1 each @hono/node-server, esbuild, uuid).

## [0.2.0] - 2026-04-11

### Fixed
- **batch3**: fix 4 blocking scrutiny issues for runway, workday, quickbooks
- **bridge**: clean brand references from template and batch1 connectors

## [0.1.0] - 2026-04-09

### Added
- **workday**: externalize Workday MCP connector to standalone package


