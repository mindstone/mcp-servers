# AGENTS.md

A monorepo of independent, source-available MCP (Model Context Protocol) servers. Each subdirectory of `connectors/` is its own npm package with its own tests, CHANGELOG, and release cadence.

**This is a public, source-available repo.** No secrets, internal URLs, ticket references, or real customer/company names belong in source, docs, or commit messages — use fictional placeholders (`Acme Corp`, `jane@example.com`) in examples and fixtures.

See `README.md` for setup, `CONTRIBUTING.md` for the contribution workflow, and `SECURITY.md` for vulnerability reporting.

## Operating principles

- Smaller diffs over sweeping rewrites. Modular over monolithic.
- Match existing patterns before inventing new ones. Reuse before duplicating.
- Treat safety and reversibility as non-negotiable; treat speed as negotiable.
- Plan the smallest coherent change, challenge it for hidden risk, run it, verify with the project's own tests, then report.
- Before acting, check for a closer `AGENTS.md` inside the directory being edited — those rules override this file within their scope.
- When reporting completion, surface remaining follow-ups, unresolved questions, and out-of-scope observations the human should know about.

## Repository layout

```
connectors/
  _template/         Starter template. Copy this when adding a new connector.
  <connector-name>/  One independent npm package per directory.
packages/            Shared workspace libraries (e.g. mcp-server-microsoft-shared); release via mcp:release in Rebel.
test-harness/        Shared test utilities, linked via `file:` dependency.
scripts/             Repo-wide maintenance scripts. Local-only by design.
docs/                Internal docs (security audits, branch protection, etc.).
.github/             CI workflows and issue/PR templates.
```

There is no root-level workspace orchestration. Always `cd` into the specific connector being worked on.

## Scope discipline

A change touches exactly one connector unless the task is explicitly repo-wide (CI workflows, `test-harness/`, or root policy files). If drift is spotted in a sibling connector, flag it in the PR description; do not fix it inline. Do not modify `connectors/_template/` unless the task is to update the template — changes there propagate to every future connector.

## Code conventions

- TypeScript, strict mode. Do not silence the compiler with `any`; fix the type instead.
- Validate every tool input and external response with Zod. No hand-rolled runtime validation.
- Build servers and tools with `@modelcontextprotocol/sdk`. Do not invent a parallel protocol layer.
- Tests use Vitest and the shared `test-harness/`. Every new tool ships with smoke, happy-path, and error tests.
- Keep runtime dependencies minimal. New deps require justification in the PR description.
- Add a comment only when the reason behind code is non-obvious. Do not narrate what well-named code already says.
- No emojis in source, commits, or PR bodies unless a user-facing tool description explicitly requires one.

## Security invariants

These are load-bearing. Do not relax, bypass, or refactor any of them without an explicit human-approved security review.

1. The repo-root `.npmrc` enforces `min-release-age=7`. Do not lower the value, comment it out, or override it per-workflow.
2. Every GitHub Action in `.github/workflows/` is pinned to a commit SHA, kept current by Dependabot. Do not pin to a tag (`@v4`) or a branch (`@main`).
3. Every workflow job declares a least-privilege `permissions:` block. Do not use `permissions: write-all` or rely on defaults.
4. Local OAuth callback servers bind to `127.0.0.1` only. Do not honour any env var that could rebind to `0.0.0.0` or an external interface.
5. File-reading and file-uploading connectors constrain reads to `MCP_WORKSPACE_PATH` (or `os.tmpdir()`) using canonical-prefix containment that handles symlinked roots. Do not replace with substring checks or non-canonical `startsWith`. The same canonical-prefix discipline applies to download targets and any path joined from external input. **Approved exception (openai-image only, 2026-07-25):** reads **and generated-image writes** may resolve through a symlink whose canonical target lands inside `MCP_WORKSPACE_PATH` **or one of the host-supplied declared-Space roots in `MCP_ALLOWED_SYMLINK_ROOTS` — the same roots the host's built-in file tools trust** — using canonical `path.relative` containment after a lexical workspace pre-gate (the candidate must resolve lexically inside `MCP_WORKSPACE_PATH` before any declared root is consulted; declared roots are reachable only via an in-workspace symlink, exactly as the built-ins reach them). The roots env is a JSON array of absolute path strings; whole-array validation is fail-closed (any non-string / empty / relative entry rejects the entire value → strict workspace-only + one stderr warning). The `os.tmpdir()` carve-out is unchanged. File-reading siblings (`nano-banana`, `google-workspace`, `pandadoc`, `microsoft-*`, etc.) remain `MCP_WORKSPACE_PATH`-strict; this exception does not extend to them.
6. Content fetched from external systems is wrapped in `<untrusted-content source="...">` envelopes with close-tag breakout escaping. Do not strip the envelopes or pass raw external strings into model-visible output. Use the shared helper `wrapUntrusted` / `wrapUntrustedJsonStrings` (canonical reference: `test-harness/src/untrusted-content.ts`; new connectors ship a vendored copy at `connectors/<name>/src/untrusted-content.ts`, as `_template` does) — do NOT hand-roll a weaker `replaceAll`-based escaper. **Never assume the host wraps connector output — it does not** (`processCallToolResult` in the Rebel host just concatenates text parts). Every external-text field is enveloped by the connector. The `scripts/check-untrusted-coverage.mjs` gate (CI matrix job `untrusted-coverage-check`) enforces an import-or-exempt decision on every network-touching connector: either reach the envelope helper, or add a `// untrusted-content-exempt: <reason>` marker for a connector that genuinely returns no model-visible external text. The gate is attention-forcing, not proof — the field-level "is this attacker-controlled" judgement stays with the §13 release security review. Known gaps are tracked in `scripts/untrusted-coverage-baseline.json` (FOX-3490 remediation program); that list only shrinks.
7. Production-impacting writes require an explicit env-var opt-in and/or `destructiveHint: true` on the tool definition. Do not flip defaults to "allowed", auto-follow redirects on downloads, or relax format validators (E.164 numbers, allow-listed hosts, etc.).

## Adding a new connector

Full workflow lives in `CONTRIBUTING.md`. Agent-relevant invariants:

- Copy `connectors/_template/`. Do not scaffold from scratch. The template ships `src/untrusted-content.ts` (the shared envelope helper, vendored) and an exemplar `list_*_resources` tool that wraps its external-text fields with `wrapUntrusted(...)` — keep that pattern for every tool that returns text authored in the external system.
- Replace every `CONNECTOR_NAME`, `CONNECTOR_TITLE`, `CONNECTOR_DESCRIPTION`, and `CONNECTOR_API_KEY` placeholder. Search the new directory for any remaining placeholder strings before opening the PR.
- Envelope external text (invariant #6). Every field whose value is authored in the third-party system (names, descriptions, bodies, comments, titles, transcripts, scraped web content, file/document content) must reach `wrapUntrusted` / `wrapUntrustedJsonStrings` before it is returned. If a connector talks to an external system but genuinely returns no model-visible external text (e.g. a generation connector returning only IDs / status / asset URLs), add a `// untrusted-content-exempt: <reason>` marker in `src/` instead. The `untrusted-coverage-check` CI job (`scripts/check-untrusted-coverage.mjs`) blocks a new network-touching connector that does neither.
- `server.json.name` and `package.json.mcpName` must be identical. CI rejects mismatches.
- Declare every required and optional environment variable in `server.json` under `packages[0].environmentVariables`.
- CI runs the manifest validator on every PR; a failing validation blocks merge.

## Version-sync invariant

**The landing rule first:** version bumps to existing connectors **and** `packages/*` shared libraries land **only** via the release tooling (`npm run mcp:release <name>` in the Mindstone Rebel repo) — never in a PR (the version-bump guard check, `.github/workflows/version-bump-guard.yml`, rejects them for both `connectors/*` and `packages/*` — see `docs/security/BRANCH_PROTECTION.md` for its branch-protection status) and never as a hand-pushed bump (release.yml refuses to publish a bump whose release commit lacks the `Release-Gate` trailer the tooling stamps). The lockstep list below is what the tooling maintains for connectors; the only time it is done by hand is a brand-new connector's bootstrap first publish (see `CONTRIBUTING.md` > Release process).

**`packages/*` shared libraries** also release via `npm run mcp:release <shared-name>` (`bump-connector.mjs --base-dir packages`). They have no `server.json`, no MCP-registry publish, and no catalogue pin. Canonical runbook: `docs/project/MCP_OSS_RELEASE_AGENT_DRIVEN.md` in the Mindstone Rebel repo (private).

When bumping a connector, the version changes in lockstep across these files:

- `connectors/<name>/package.json` — `version`.
- `connectors/<name>/package-lock.json` — top-level `version` and `packages[""].version`.
- `connectors/<name>/server.json` — top-level `version` and `packages[0].version`.

`connectors/<name>/STATUS.json` is deliberately **not** on this list: schema v2 (2026-06-11) stores no version — it is derived from `package.json`, and `scripts/check-status.mjs` rejects a STATUS.json that contains a `version` field. Do not add one back; that would re-create the version-lag drift class this removal killed (see `docs/plans/260609_catalogue_drift_prevention.md`, Option 4).

CI rejects PRs where these drift. The git tag at release time must also match.

**server.json content edits land via PR** (the "server.json check" CI workflow gates pre-merge) **or only after `node scripts/check-server-json.mjs <connector>` passes locally** — the MCP registry enforces rules server-side (e.g. description length <= 100) that no local schema check catches, so a direct-pushed server.json edit without that round-trip turns `main` red (260611 canary incident). The script fails closed when offline; `bump-connector.mjs` runs it automatically as a precondition.

Bumping a version (or adding/removing a connector) also changes **generated, committed artifacts**. The release tooling regenerates them itself; for any other change that affects them (new connector, README tagline edit, etc.), regenerate and commit them in the same change, or CI on `main` goes red:

```bash
node scripts/build-catalogue.mjs      # docs/catalogue/<name>.md + docs/index.md
node scripts/gen-install-links.mjs    # the INSTALL_LINKS block in each connector README
```

(`--check` is the read-only CI variant of each.) See `docs/plans/260609_catalogue_drift_prevention.md` for why these are committed today and the options for removing the drift surface entirely.

## CHANGELOG conventions

- Each connector has its own `CHANGELOG.md` following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
- A `package.json` version bump requires a matching `## [<version>] - YYYY-MM-DD` header introduced in the same change. The release tooling does this promotion automatically; for bootstrap first-add PRs (the only PRs allowed to carry a version), the changelog-check CI workflow enforces it.
- Use only the standard headings: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`.
- Re-insert an empty `## [Unreleased]` block above the new version header.
- Never invoke `scripts/backfill-changelog.sh` from CI or a workflow — it is local-only by design.

## Commit and PR conventions

- One logical change per PR. Refactors and behaviour changes go in separate commits and ideally separate PRs. **Version bumps never go in a PR at all** — they land only via the release tooling (see Version-sync invariant above); the `version-bump-guard` CI check rejects PRs that bump an existing connector.
- Use Conventional Commits: `<type>(<scope>): <summary>`. `<scope>` is the connector name for connector-touching changes (e.g. `feat(zendesk): ...`, `fix(hubspot): ...`); use `chore(release): ...` for release-process work.
- Commit messages describe what changed and why.
- Keep private info out of commit messages. Treat the subject, body, and trailers as potentially-public text — this repo publishes its real commit history. No PII, real user/customer names, private conversation content, internal hostnames, or secrets; reference a ticket (e.g. a Linear or Sentry issue) and keep the detail there. Canonical guidance: `coding-agent-instructions/docs/GIT_COMMIT_CHANGES.md`.
- Do not name AI tools or models in commit messages, PR titles, PR bodies, branch names, or `Co-authored-by:` lines. This applies to code/PR commits. The `Release-Gate: <path>#<sha256>` trailer that the release tooling stamps on release commits is process metadata (it names no AI tool) and is required there — do not strip it, and do not hand-write it on ordinary commits.
- Only commit changes from the current task. Selectively `git add` the files actually modified; do not use `git add -A` or `git add .` when unrelated changes exist in the working tree.
- Stop before destructive git actions (discarding work, force-checkout, dropping stashes, hard resets, force-pushing shared branches) and confirm with the user.
- If a PR changes a connector's behaviour, update that connector's `README.md` in the same PR.
- Run the connector's lint and tests locally before pushing. Do not rely on CI to surface basic failures.

## Per-connector AGENTS.md

If `connectors/<name>/AGENTS.md` exists, its rules override this file within that connector's scope. Root rules apply by default; nested files refine.

## Common mistakes to avoid

- Edit exactly one connector per change; do not harmonise siblings inline.
- Bump `package.json`, `package-lock.json`, and `server.json` in lockstep, not one at a time.
- Keep `--ignore-scripts` on install and publish commands; diagnose the real cause if a build fails.
- Pin GitHub Actions to commit SHAs; do not retag to `@v4` or `@main` to "fix" a workflow.
- Keep `<untrusted-content>` envelopes intact; they are a security boundary, not formatting noise.
- Do not add a root-level script that touches every connector. Maintenance scripts live in `scripts/` and operate on one connector at a time.
