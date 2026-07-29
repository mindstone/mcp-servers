# Changelog

All notable changes to this connector are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added `vanta_deactivate_vulnerability_monitoring` and `vanta_reactivate_vulnerability_monitoring` using the current Vanta endpoints.

### Removed

- Removed `vanta_update_vulnerability` because the current Vanta API provides monitoring toggles instead of a generic update.
- Removed `vanta_list_evidence` and `vanta_list_resources` because the current Manage Vanta reference has no `GET /v1/evidence` endpoint and no tenant-wide `GET /v1/resources` endpoint.

### Fixed

- Corrected the OAuth token exchange scope from the invalid `vanta-api.all:read-write` string to Vanta's documented `vanta-api.all:read vanta-api.all:write` pair.
- Resolved all standard `VANTA_REGION` values to Vanta's canonical `api.vanta.com` host for both token exchange and API calls; `VANTA_REGION` remains accepted as a validated compatibility no-op.
- Rebuilt `vanta_get_compliance_summary` on Vanta's documented `GET /v1/frameworks` counters instead of nonexistent fields on test records.
- Updated `vanta_query_test_results` to call the documented `GET /v1/tests/{testId}/entities` endpoint and use its `entityStatus` filter.
- Fixed list-filter query parameter names for vulnerabilities, tests, controls, people, and vendors so filters are sent using the names declared in Vanta's OpenAPI reference.
- Repaired `vanta_create_vendor` to send the correct fields (`name`, `websiteUrl`, `category`, `additionalNotes`, `accountManagerName`, `accountManagerEmail`) as documented.
- Repaired `vanta_update_vendor` to use the `PATCH` method and the correct field names.
- Added a source-stamped Vanta contract snapshot and tests that assert surviving read tools only call documented paths with documented query parameters.

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
