# Contributing to Mindstone MCP Servers

Thanks for your interest in contributing! This document explains how to get involved.

## Getting Started

1. Fork the repository
2. Clone your fork and create a feature branch:
   ```bash
   git clone https://github.com/<your-username>/mcp-servers.git
   cd mcp-servers
   git checkout -b my-feature
   ```
3. Each connector is self-contained under `connectors/<name>/`. Install and build independently:
   ```bash
   cd connectors/<name>
   npm install
   npm run build
   ```

## Repository Structure

```
connectors/
  _template/       # Starter template for new connectors
  zendesk/         # Each connector is an independent package
  freshdesk/
  ...
test-harness/      # Shared test utilities (linked via file: dependency)
```

## Adding a New Connector

1. Copy `connectors/_template/` to `connectors/<your-connector>/`
2. Update `package.json` with the connector name and description (replace every `CONNECTOR_NAME` placeholder; keep the `mcpName` field — see [Registry submission](#registry-submission) below)
3. Update `server.json` — replace every `CONNECTOR_NAME`, `CONNECTOR_TITLE`, and `CONNECTOR_DESCRIPTION` placeholder; declare every required and optional environment variable in `packages[0].environmentVariables`; remove the placeholder `CONNECTOR_API_KEY` block if your connector uses a different auth model
4. Update the `LICENSE` file — replace the placeholder software name
5. Implement the connector following the patterns in existing connectors
6. Add tests using the shared test harness
7. Add a `README.md` with setup and configuration instructions
8. Verify locally: `npm run build && npm test && mcp-publisher validate server.json` (see [Registry submission](#registry-submission) for the publisher CLI)
9. Submit a pull request

## Registry Submission

Every connector ships a `server.json` manifest so it can be discovered through the [official MCP Registry](https://registry.modelcontextprotocol.io). The template includes one already; you only need to fill in the placeholders.

### What you need to know

- The `name` field uses reverse-DNS namespacing under the org's GitHub identity: `io.github.mindstone/mcp-server-<connector>`. Do not change the `io.github.mindstone/` prefix — the registry uses GitHub OIDC to verify ownership of that namespace.
- The `mcpName` field in `package.json` MUST equal `server.json.name`. The registry reads `mcpName` from the published npm metadata to confirm whoever pushes the manifest owns the package. CI checks this for you (see `.github/workflows/server-json-check.yml`).
- Three versions must stay in sync: the git tag, `package.json.version`, and `server.json.version` (which is also `server.json.packages[0].version`). The publish workflow already enforces this for tags ↔ package.json; the new CI job enforces it across `server.json` too.
- The `_meta.io.modelcontextprotocol.registry/publisher-provided.com.mindstone.rebel` block carries `catalogId` and `provider` for round-trip identity with the Rebel app's connector catalog. Leave these in unless you know your connector will never be added to Rebel's catalog.

### Validating locally

```bash
# Install the publisher CLI once (macOS via Homebrew)
brew install mcp-publisher
# Linux: download from https://github.com/modelcontextprotocol/registry/releases

cd connectors/<your-connector>
mcp-publisher validate server.json
```

A passing validate is required before opening a PR. CI runs the same check on every PR — see `.github/workflows/server-json-check.yml`.

### Publishing to the registry

Maintainer task, not a contributor task. After a connector is tagged and the npm publish workflow ships a new version, the maintainer registers (or updates) the entry with:

```bash
mcp-publisher login github-oidc
mcp-publisher publish connectors/<connector>/server.json
```

This step is currently manual; it will move into the publish workflow once provenance attestations land.

## Development Guidelines

- **TypeScript**: All connectors are written in TypeScript with strict mode
- **Testing**: Use Vitest. Every connector should have smoke tests, tool tests, and error handling tests
- **Linting**: Run `npm run lint` before submitting
- **Dependencies**: Keep dependencies minimal. Use the MCP SDK (`@modelcontextprotocol/sdk`) and Zod for validation

## Pull Requests

- Keep PRs focused on a single change
- Include tests for new functionality
- Update the connector's README if behaviour changes
- Ensure all existing tests pass: `npm test`
- Use clear commit messages describing what changed and why

## Release process

Every connector ships its own `CHANGELOG.md` following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The release flow is intentionally manual and human-readable; no tool runs in CI translates commits into release notes (see the [Why no auto-generation in CI](#why-no-auto-generation-in-ci) note below).

### Bumping a connector

1. Bump the version in lockstep in three places:
   - `connectors/<name>/package.json` — the `version` field
   - `connectors/<name>/package-lock.json` — the top-level `version` and `packages[""].version`
   - `connectors/<name>/server.json` — the top-level `version` and `packages[0].version`
2. Promote `## [Unreleased]` to `## [<new-version>] - YYYY-MM-DD` in `connectors/<name>/CHANGELOG.md` and re-insert an empty `## [Unreleased]` block above it.
3. Write the release notes yourself. Group entries under the standard headings (`Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`).
4. Open a PR. The `CHANGELOG check` workflow (`.github/workflows/changelog-check.yml`) fails the PR if the new `package.json.version` does not have a corresponding `## [<new-version>] - <date>` header in `CHANGELOG.md`, or if that header was carried from `main` rather than introduced in the PR.

### Why no auto-generation in CI

The release procedure (manual `npm publish` from the wave-lead's dev machine, see `docs/PUBLISH_APPROVAL_PROCESS.md`) deliberately runs no auto-generation tooling. Any process that translates commit history into release-artifact text expands the attack surface a supply-chain compromise (see [docs/security/AUDIT_FOX-3319_tanstack_supply_chain.md](docs/security/AUDIT_FOX-3319_tanstack_supply_chain.md)) can reach: a malicious dependency that hooks the changelog renderer can rewrite the public-facing notes for every package on the maintainer's machine. The CHANGELOG content that gets shipped is whatever lives in `connectors/<name>/CHANGELOG.md` at the publish commit, period.

For a one-shot migration from a sparse history (or for prototyping while you draft entries yourself), `scripts/backfill-changelog.sh` runs [git-cliff](https://git-cliff.org/) at a SHA-pinned version against your local checkout. **It is local-only by design; never invoke it from a workflow.** Re-running on a connector that already has a `CHANGELOG.md` is a no-op unless you pass `FORCE=1`.

## Reporting Issues

- **Security vulnerabilities**: See [SECURITY.md](SECURITY.md) — do not open public issues
- **Bugs**: Open a GitHub issue with reproduction steps
- **Feature requests**: Open a GitHub issue describing the use case

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to uphold it.

## Licence

By contributing, you agree that your contributions will be licensed under the same [FSL-1.1-MIT](LICENSE) licence as the rest of the project.
