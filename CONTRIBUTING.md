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
8. Create `STATUS.json`: run `node scripts/init-status.mjs <your-connector>`, then set the `surface` and verify `auth.type` (the script leaves `surface: "TBD"`, which CI rejects). If your connector registers tools in a way `scripts/check-status.mjs` can't count yet (e.g. a `server.tool(...)` factory over an array), see the exclusion list in `.github/workflows/ci.yml` and `docs/plans/260609_catalogue_drift_prevention.md`.
9. Regenerate the committed derived files and commit them: `node scripts/build-catalogue.mjs && node scripts/gen-install-links.mjs` (adds your catalogue page, the index row, and the README install-links block)
10. Verify locally: `npm run build && npm test && mcp-publisher validate server.json` (see [Registry submission](#registry-submission) for the publisher CLI)
11. Submit a pull request

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

### Date & timestamp fields

Strict MCP hosts validate a tool call against the connector's **exported** JSON
schema *before* the connector code runs, and LLMs frequently send ISO date
strings for timestamp fields. A field exported as bare `type: number` therefore
gets such calls rejected at the host boundary — your runtime coercion never
runs. Rules:

- **Epoch-ms fields MUST advertise `number | string` in the exported schema**,
  coerce parseable date strings to epoch ms at runtime, and reject un-coercible
  strings with an actionable message. Digit-only strings are accepted only in
  the unambiguous epoch-ms window `[1e12, 1e14)`; anything else — notably Unix
  *seconds* like `"1735689600"`, which would silently be 1000x off — is
  rejected, and digit-only strings must never fall through to `Date.parse`
  (V8 reads `"5"` as the year 2005). Copy the `epochMsField()` helper from
  `connectors/_template/src/server.ts` (export shape verified by connector
  tools/list tests under the current SDK/zod v3 lockfile; keep a tools/list
  export test when changing SDK/Zod versions).
- **Plain date-string fields** (e.g. `YYYY-MM-DD` passed through to the API)
  use `z.string()` with the exact accepted format in the description.
- **Every date/timestamp field's description states the accepted forms with an
  example**, e.g. `'Unix timestamp in milliseconds (number, e.g. 1735689600000)
  or a parseable date string (e.g. "2026-01-01")'`.

Add a tools/list test asserting the exported schema accepts both forms — see
`connectors/retell-ai/test/tools/calls-timestamps.test.ts` for the pattern.

## Pull Requests

- Keep PRs focused on a single change
- Include tests for new functionality
- Update the connector's README if behaviour changes
- Ensure all existing tests pass: `npm test`
- Use clear commit messages describing what changed and why

## Release process

Every connector ships its own `CHANGELOG.md` following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Release notes are human-written, never generated from commit history (see [Why no changelog auto-generation](#why-no-changelog-auto-generation) below).

### The landing rule

There is exactly one rule for how changes reach `main` and npm:

- **Code changes** land via PR (preferred for external contributions and anything non-trivial) or maintainer direct push — **without version changes**. Keep adding your release notes under `## [Unreleased]` in the connector's `CHANGELOG.md` as you go.
- **Version bumps and releases** land **only** via the release tooling — `npm run mcp:release <connector>`, run from the Mindstone Rebel repo. The tooling bumps every version surface in lockstep (`package.json`, `package-lock.json`, `server.json` — `STATUS.json` stores no version under schema v2), promotes `## [Unreleased]` to the new version header, regenerates the committed catalogue/install-links artifacts, runs the pre-release security-review gate, and stamps the release commit with the `Release-Gate` trailer that `.github/workflows/release.yml` requires before publishing to npm and the MCP registry.
- **Never bundle a version bump into a PR.** The version-bump guard check (`.github/workflows/version-bump-guard.yml`; see [`docs/security/BRANCH_PROTECTION.md`](docs/security/BRANCH_PROTECTION.md) for its branch-protection status) fails any PR that changes the `version` of an existing connector. If your fix deserves a release, say so in the PR description — a maintainer runs the release tooling after your code lands.
- **First publishes are the exception**: a brand-new connector's bootstrap publish is a manual maintainer task (see below). The PR guard and the publish workflow both exempt packages that did not exist at the base ref.

Why so strict: on this repo, a version bump reaching `main` *is* the publish trigger (`release.yml` publishes via Trusted Publishing OIDC). Routing every bump through the release tooling keeps a single gate-complete path — security review, version-surface lockstep, artifact regeneration, and publish verification — instead of two paths that each skip the other's gates.

### First publish of a new connector (bootstrap — maintainers only)

`release.yml` only publishes packages that already exist on npm under Trusted Publishing; a brand-new connector's first publish is manual (WebAuthn-gated `npm publish` per `docs/PUBLISH_APPROVAL_PROCESS.md`, then Trusted Publisher setup at npmjs.com). For that first publish only, the version surfaces are set locally — via the shared bump script, never file-by-file:

1. Set every version surface in one go with the shared bump script — the same implementation the release tooling uses:
   ```bash
   node scripts/bump-connector.mjs <name> --to <version> --changelog-entry "Initial release"
   ```
   It bumps `package.json`, `package-lock.json`, and `server.json` (both `version` fields) in lockstep, promotes `## [Unreleased]` to a `## [<version>] - YYYY-MM-DD` block, and regenerates the committed catalogue + install-links artifacts. (`STATUS.json` stores no version under schema v2 — it is derived from `package.json` — so the script does not touch it.) Run it with no arguments for usage; it never commits. (Hand-editing these files is exactly the drift class that once left `main` red for 11+ days — see `docs/plans/260609_catalogue_drift_prevention.md`.)
2. Edit the new `CHANGELOG.md` block: replace the generated line with hand-written notes under the standard headings (`Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`) — release notes are human-written, never generated (see below). Keep the empty `## [Unreleased]` block above it.
3. Land it (the new-connector PR typically includes this), then follow the manual publish runbook in `docs/PUBLISH_APPROVAL_PROCESS.md`.

All *subsequent* releases of that connector go through `npm run mcp:release` like everything else.

### Why no changelog auto-generation

No tool — in CI or in the release tooling — translates commit history into release-note text. Any process that does expands the attack surface a supply-chain compromise (see [docs/security/AUDIT_FOX-3319_tanstack_supply_chain.md](docs/security/AUDIT_FOX-3319_tanstack_supply_chain.md)) can reach: a malicious dependency that hooks the changelog renderer can rewrite the public-facing notes for every package. The CHANGELOG content that ships is whatever humans (and reviewed agents) wrote in `connectors/<name>/CHANGELOG.md` at the release commit, period. (CI *does* publish — `release.yml` via Trusted Publishing — but it publishes the reviewed, gate-trailed release commit verbatim; it generates no release-artifact text.)

For a one-shot migration from a sparse history (or for prototyping while you draft entries yourself), `scripts/backfill-changelog.sh` runs [git-cliff](https://git-cliff.org/) at a SHA-pinned version against your local checkout. **It is local-only by design; never invoke it from a workflow.** Re-running on a connector that already has a `CHANGELOG.md` is a no-op unless you pass `FORCE=1`.

## Reporting Issues

- **Security vulnerabilities**: See [SECURITY.md](SECURITY.md) — do not open public issues
- **Bugs**: Open a GitHub issue with reproduction steps
- **Feature requests**: Open a GitHub issue describing the use case

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to uphold it.

## Licence

By contributing, you agree that your contributions will be licensed under the same [FSL-1.1-MIT](LICENSE) licence as the rest of the project.
