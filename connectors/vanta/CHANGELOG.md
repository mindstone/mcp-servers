# Changelog

All notable changes to this connector are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added `vanta_deactivate_vulnerability_monitoring` and `vanta_reactivate_vulnerability_monitoring` using the current Vanta endpoints.
- Added `vanta-api.documents:upload` to the requested OAuth scopes; Vanta requires it for the document-upload endpoint and it is separate from `vanta-api.all:write`. A Manage Vanta app that cannot request all three scopes now fails token exchange with `invalid_scope`, and the error names the scopes to add.
- Added multipart/form-data support to the API client so the upload tools can send files the way Vanta's endpoints require.

### Changed

- `vanta_upload_document` now takes `document_id` (an existing Vanta document) plus optional `effective_at_date` and `file_name`, and reports `submission_required` because Vanta files API uploads as drafts until the document is submitted for review; `document_name` was renamed to `file_name` for this tool.
- `vanta_attach_vendor_document` now requires `document_type` (Vanta requires the `type` form field) and treats `document_name` as the optional document title.

### Security

- Document uploads fetch the caller-supplied URL server-side, so the fetch is bounded: HTTPS-only, at most 3 redirects with every hop re-validated against the private-address guard, a 30-second timeout, a 25 MB cap enforced while streaming rather than trusting `Content-Length`, sanitized file names, and a safe fallback content type derived from a sanitized source header (no byte-level MIME sniffing). Each refusal returns its own error code (`SOURCE_TOO_LARGE`, `SOURCE_TIMEOUT`, `SOURCE_UNREACHABLE`, `SOURCE_REDIRECT_LIMIT`, or `CONFIG_INVALID`) instead of a generic failure.

### Removed

- Removed `vanta_update_vulnerability` because the current Vanta API provides monitoring toggles instead of a generic update.
- Removed `vanta_list_evidence` and `vanta_list_resources` because the current Manage Vanta reference has no `GET /v1/evidence` endpoint and no tenant-wide `GET /v1/resources` endpoint.

### Fixed

- Corrected the OAuth token exchange scope from the invalid `vanta-api.all:read-write` string to Vanta's documented space-separated scope list.
- Rebuilt `vanta_upload_document` and `vanta_attach_vendor_document` on Vanta's documented multipart upload endpoints (`POST /v1/documents/{documentId}/uploads` and `POST /v1/vendors/{vendorId}/documents`); both previously sent JSON bodies, and the document tool posted to an endpoint whose required fields it never sent.
- Resolved all standard `VANTA_REGION` values to Vanta's canonical `api.vanta.com` host for both token exchange and API calls; `VANTA_REGION` remains accepted as a validated compatibility no-op.
- Rebuilt `vanta_get_compliance_summary` on Vanta's documented `GET /v1/frameworks` counters instead of nonexistent fields on test records.
- Updated `vanta_query_test_results` to call the documented `GET /v1/tests/{testId}/entities` endpoint and use its `entityStatus` filter.
- Fixed list-filter query parameter names for vulnerabilities, tests, controls, people, and vendors so filters are sent using the names declared in Vanta's OpenAPI reference.
- Repaired `vanta_create_vendor` to accept the documented minimum body (`name`), while still mapping optional vendor fields (`websiteUrl`, `category`, `additionalNotes`, `accountManagerName`, `accountManagerEmail`) when provided.
- Added optional `risk_level` on `vanta_create_vendor`, mapped to Vanta's documented `inherentRiskLevel` field.
- Repaired `vanta_update_vendor` to use the `PATCH` method and the correct field names.
- Updated vendor category guidance to describe Vanta's documented free-form category displayName values (for example `cloudMonitoring`) instead of invented enums.
- Corrected the README status summary to reflect the 17-tool surface (11 read + 6 write).
- Added a source-stamped Vanta contract snapshot and tests that assert surviving read tools only call documented paths with documented query parameters.
- Lowered the page-size cap from 500 to Vanta's documented maximum of 100, including the single-page `getById` fallback scan, whose recall is now limited to the first 100 records (full cursor pagination is a logged follow-up).
- Lowered the shared API rate limiter from 60 requests/minute to Vanta's documented 50 requests/minute limit (Manage Vanta overview; the token endpoint is separately limited to 5 requests/minute).
- Fixed stale rate-limit documentation and comments that still advertised 60 requests/minute.
- Aligned `STATUS.json` domains with the README's compliance-summary domain.

## [0.1.0] - 2026-05-19

### Added

- Initial OSS release. Ports the bundled Vanta MCP server to `@mindstone/mcp-server-vanta`.
- 18 tools across 9 domains: vulnerabilities, tests, controls, resources, evidence, people, query results, compliance summary, vendors, documents.
- 13 read tools + 5 write tools (`vanta_create_vendor`, `vanta_update_vendor`, `vanta_attach_vendor_document`, `vanta_update_vulnerability`, `vanta_upload_document`).
- OAuth client-credentials grant with 1-hour token TTL and single-flight token refresh.
- Region allowlist: `us`, `eu`, `aus`. Invalid `VANTA_REGION` fails closed with `CONFIG_INVALID`.
- 60-requests-per-minute shared rate limiter, `Retry-After` honoured with a 2-minute cap, 3-retry budget.
- 25 KB response size cap with binary-search truncation; 2 MB pre-parse safety cap.
- HTTPS-only URL validation on `attach_vendor_document` and `upload_document` (rejects `file:`, localhost, RFC1918, link-local incl. IMDS, IPv6 loopback / link-local / ULA, IPv4-mapped IPv6, and hostnames whose DNS records resolve to any of the above).
- Bearer / `Authorization` / `access_token` / `refresh_token` / `client_secret` redaction in error text.
- Recovery-guidance error contract: `{ ok, error, code, action_required, next_step }`.
