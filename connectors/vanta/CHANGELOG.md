# Changelog

All notable changes to this connector are documented here.

## 0.1.0 — 2026-05-19

Initial release. Ports the bundled Vanta MCP server to OSS.

- 18 tools across 9 domains (vulnerabilities, tests, controls, resources, evidence, people, query results, compliance summary, vendors, documents).
- 11 read tools + 7 write tools (create_vendor, update_vendor, attach_vendor_document, update_vulnerability, upload_document).
- OAuth client-credentials grant with 1-hour token TTL and single-flight refresh.
- Region allowlist: `us`, `eu`, `aus`.
- 60-requests-per-minute shared rate limiter, retry-after honouring with 2-minute cap, 3-retry budget.
- 25 KB response size cap with binary-search truncation; 2 MB pre-parse safety cap.
- HTTPS-only URL validation on `attach_vendor_document` and `upload_document` (rejects `file:`, localhost, RFC1918, link-local, and other non-public addresses).
- Bearer-token redaction in error text.
- Recovery-guidance error contract: `{ ok, error, code, action_required, next_step }`.
