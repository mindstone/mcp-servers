# Security Policy — `@mindstone/mcp-server-office`

## Reporting a Vulnerability

If you discover a security vulnerability in this connector, please report it
responsibly. **Do not open a public GitHub issue for security vulnerabilities.**

See the repository-level [SECURITY.md](../../SECURITY.md) for the canonical
vulnerability-reporting process, SLAs, and scope. The instructions below are a
connector-specific summary for convenience — in any case of conflict the
repository-level policy wins.

### How to Report

Email **security@mindstone.com** with:

- **Affected connector(s):** `@mindstone/mcp-server-office`
- **Description:** clear description of the vulnerability
- **Reproduction steps:** step-by-step instructions to reproduce
- **Impact assessment:** what an attacker could achieve
- **Suggested fix (optional):** any recommendation you have

### What to Expect

- **Acknowledgement** within 2 business days.
- **Initial assessment** within 5 business days.
- **Fix** targeted within 30 days of confirmation, depending on complexity.
- **Disclosure** coordinated with you after a fix is available.

## Scope

This policy covers:

- The stdio MCP server (`dist/index.js`)
- The Office sidecar (`dist/sidecar/cli.js`) — local HTTPS server + WebSocket bridge
- The Office Add-in task pane assets (`dist/addin/`) loaded into Word / Excel / PowerPoint
- Vendored shared contracts in `src/shared/sidecar/` and `src/shared/appBridge/`
- The `manifest.xml` Office Add-in manifest template

Relevant areas of attention when reviewing reports:

- The sidecar binds to `127.0.0.1` on a dynamic port and authenticates clients
  with a per-run token written to the state file. Token handling and
  constant-time comparisons in `src/shared/sidecar/constantTime.ts` are
  in-scope.
- The sidecar generates a trusted localhost HTTPS certificate via
  `office-addin-dev-certs`. Certificate handling and the one-time trust prompt
  are in-scope.
- The taskpane → sidecar → MCP call path carries host-mediated content (Office
  documents). Authentication, authorisation, and input validation along that
  path are in-scope.

## Out of Scope

- Vulnerabilities in Microsoft Office itself or Office.js
- Vulnerabilities in `office-addin-dev-certs`, `@modelcontextprotocol/sdk`, or
  other third-party dependencies (report to the respective projects)
- Issues that require an attacker to already have local code execution on the
  user's machine
- Cloud surfaces — this connector is desktop-only by design

## Supported Versions

Security fixes are published on the latest npm version. Always use the most
recent release.
