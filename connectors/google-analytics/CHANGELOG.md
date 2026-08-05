# Changelog

All notable changes to this connector are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The history below `[Unreleased]` was reconstructed from git history during the
`@mindstone-engineering` to `@mindstone` npm scope migration; subsequent entries
are maintained manually as part of the PR review checklist.

## [Unreleased]

### Added
- `ga_list_audiences` and `ga_list_channel_groups` (Admin API v1alpha) — list configured audiences (with filter clauses) and channel groups (with grouping rules).
- Audience export tools (Data API v1beta): `ga_create_audience_export`, `ga_get_audience_export`, `ga_list_audience_exports`, `ga_query_audience_export` — user-level snapshots of audiences, including predictive segments.
- Report task tools (Data API v1alpha): `ga_create_report_task`, `ga_get_report_task`, `ga_query_report_task` — asynchronous large exports without synchronous timeouts or the row-volume gate.
- Error-path and per-tool test suites (quota 429, unknown property 404, invalid dimension 400, permission denied, missing property ID, not-yet-ACTIVE export/task queries, row-volume warning and estimate-only paths).

### Fixed
- `ga_list_bigquery_links` and `ga_get_global_site_tag` now call the Admin API v1alpha base: neither resource exists on the v1beta surface, so both tools would fail against the real API.
- `ga_search_change_history_events` no longer silently truncates at the first 100 events — it follows `nextPageToken` until the result set is exhausted.
- `dimension_filter` / `metric_filter` inputs are fail-closed validated against the GA4 `FilterExpression` structure instead of being passed through unvalidated.

### Security
- External text is now returned inside `<untrusted-content>` envelopes: report dimension values (campaign names, page titles, custom-dimension values), user-authored admin display names/descriptions, audience and channel-group definition blobs, custom-definition metadata, and audience-export row values. Metric values and resource identifiers stay raw.
- Vendor error text can no longer reach model-visible output raw: Google API error messages are enveloped (`ga4-api-error`), the `statusText` fallback is replaced with a sanitised status-only message, unparseable response bodies fail closed with `INVALID_API_RESPONSE` instead of leaking parser-generated body fragments, and unexpected runtime errors are logged to server stderr while the model receives a sanitised `UNEXPECTED_ERROR` message.
- Vendor-echoed names used as structural output keys (report dimension/metric header names, audience-export dimension names) and pivot header blobs are enveloped with close-tag breakout escaping.
- `reportMetadata.errorMessage` on report tasks is enveloped before returning.
- `ga_create_audience_export` and `ga_create_report_task` are now annotated `destructiveHint: true` so hosts can gate these quota-charging server-side materialisations behind explicit user approval.
- Audience-export and report-task API responses are validated against Zod schemas at the boundary instead of being TypeScript-cast only.

## [0.1.1] - 2026-05-14
### Added
- **registry**: Cohort B + C backfill — 13 OSS connectors get server.json (12 also get mcpName). google-analytics, hubspot, outreach, quickbooks, salesforce, servicenow, slack, workday, zendesk, office (5-service consolidator), apple-shortcuts, browser-automation, email-imap each gain a registry-shaped server.json validated against registry.modelcontextprotocol.io. mcpName added to 12 of 13 package.json files; browser-automation deferred due to a concurrent agent's uncommitted 0.1.5→0.1.6 version bump in the same file.

### Fixed
- **ci**: Add npm overrides for fast-uri, hono, ip-address across all connectors.

### Changed
- Republished under the `@mindstone` npm scope. The legacy `@mindstone-engineering/mcp-server-*` package on this version line will be deprecated as part of the FOX-3319 scope migration; see [MIGRATION.md](../../MIGRATION.md) for the procedure consumers should follow.

## [0.1.0] - 2026-04-29

### Added
- **google-analytics**: Add Google Analytics 4 MCP server. New rebel-oss connector exposing 25 read-only tools across reporting, schema discovery, and admin visibility for GA4.


