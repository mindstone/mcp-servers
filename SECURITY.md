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

## Maintainer Release Security

Every real connector release is treated as a supply-chain event. A package publish can become a production deployment when the consuming Rebel catalog pins the new version.

Before publishing or asking the host application to pin a new version:

- Complete the pre-publish security review required by the consuming Rebel repo's `docs/project/OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES.md` § 13.
- Record the review in the consuming repo under `docs/reports/security-reviews/<yyMMdd>_<connector>_<version>.md`.
- Include the machine-readable release gate block from `docs/security/MCP_RELEASE_SECURITY_REVIEW_TEMPLATE.md`.
- Resolve all Critical findings and ensure all High findings are either fixed or explicitly accepted by a named maintainer with a tracking issue.
- Verify the release commit, npm package name, MCP registry `server.json` name, and catalog ID all refer to the same connector.

For packages using npm Trusted Publishing, the GitHub `npm-publish` environment name is part of the npm trust configuration. If that GitHub environment has no required reviewers, the push to `main` that triggers the release workflow is the final human approval before publish.

Do not use shared npm credentials for routine releases. Use named npm accounts for organization administration and GitHub OIDC Trusted Publishing for normal package publishes once a package is bootstrapped.
