# @mindstone/mcp-server-vanta

Vanta compliance MCP server — read and write vulnerabilities, tests, controls, evidence, resources, people, vendors, and compliance summaries via the Vanta API.

## Status

- **Version:** [0.1.0](./CHANGELOG.md) · [npm](https://www.npmjs.com/package/@mindstone/mcp-server-vanta)
- **Auth:** OAuth client-credentials grant (`VANTA_CLIENT_ID` + `VANTA_CLIENT_SECRET`)
- **Tools:** 18 (13 read + 5 write across vulnerabilities, tests, controls, resources, evidence, people, vendors, documents, compliance summary)
- **Surface:** cloud-api
- **Regions:** US, EU, AUS (set via `VANTA_REGION`)

## Installation

```bash
npx -y @mindstone/mcp-server-vanta
```

## Configuration

Set these environment variables before starting the server:

- `VANTA_CLIENT_ID` — Vanta OAuth Client ID (required)
- `VANTA_CLIENT_SECRET` — Vanta OAuth Client Secret (required)
- `VANTA_REGION` — `us` (default), `eu`, or `aus`
- `VANTA_REQUEST_TIMEOUT_MS` — request timeout in milliseconds (default 60000)

To generate credentials, open the [Vanta Developer Console](https://app.vanta.com/settings/developer-console), create a new OAuth client with the "Manage Vanta" (read-write) scope, and copy the Client ID and Client Secret.

## Tools

### Read

- `vanta_list_vulnerabilities` / `vanta_get_vulnerability`
- `vanta_list_tests` / `vanta_get_test`
- `vanta_list_controls` / `vanta_get_control`
- `vanta_list_resources`
- `vanta_list_evidence`
- `vanta_list_people`
- `vanta_query_test_results`
- `vanta_get_compliance_summary`
- `vanta_list_vendors` / `vanta_get_vendor`

### Write

- `vanta_create_vendor`
- `vanta_update_vendor`
- `vanta_attach_vendor_document`
- `vanta_update_vulnerability`
- `vanta_upload_document`

## Safety

This server enforces:

- HTTPS-only URL validation on document attachment tools (rejects `file:`, `localhost`, RFC1918, link-local, and other internal addresses).
- 60-requests-per-minute rate limiting with single-flight token exchange.
- Response truncation at 25 KB with binary-search trimming.
- Bearer-token redaction in all error messages.

## License

[FSL-1.1-MIT](./LICENSE)
