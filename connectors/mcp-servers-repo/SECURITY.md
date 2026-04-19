# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in any of our MCP connectors, please report it responsibly. **Do not open a public GitHub issue for security vulnerabilities.**

### How to Report

Email **security@mindstone.com** with the following information:

- **Affected connector(s):** Which connector(s) are impacted (e.g. `mcp-server-quickbooks`)
- **Description:** A clear description of the vulnerability
- **Reproduction steps:** Step-by-step instructions to reproduce the issue
- **Impact assessment:** What an attacker could achieve by exploiting this vulnerability
- **Suggested fix (optional):** If you have a recommendation for how to address the issue

### What to Expect

- **Acknowledgement:** We will acknowledge receipt of your report within **2 business days**.
- **Assessment:** We will investigate and provide an initial assessment within **5 business days**.
- **Resolution:** We aim to release a fix within **30 days** of confirming the vulnerability, depending on complexity.
- **Disclosure:** We will coordinate with you on public disclosure timing after a fix is available.

### Scope

This policy covers all connectors in this repository:

- All MCP server connectors under `connectors/`
- Shared utilities and templates under `connectors/_template/`

### Out of Scope

- Vulnerabilities in third-party APIs that our connectors integrate with (e.g. Zendesk, Freshdesk, Workday)
- Issues in the Model Context Protocol SDK itself — please report those to the [MCP SDK repository](https://github.com/modelcontextprotocol/sdk)

## Supported Versions

We provide security updates for the latest published version of each connector. We recommend always using the most recent version.
