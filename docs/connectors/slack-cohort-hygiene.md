# Slack MCP — cohort hygiene

Implementation-specific guarantees baked into `@mindstone/mcp-server-slack` that go beyond what is captured in the README. This file is for reviewers, downstream maintainers, and anyone hardening a similar Slack MCP — it is not normally read by end users.

The same patterns are applied across every connector in this monorepo where they make sense; calling them out here makes it easier to spot regressions in Slack specifically.

## Guarantees

- **`SERVER_VERSION` from `package.json`** — never drifts from the published version.
- **Tool annotations** — every tool declares `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` accurately.
- **Recovery-guidance contract** — every error response includes `action_required` and `next_step`.
- **Request timeout** — 60s default, overridable via `SLACK_REQUEST_TIMEOUT_MS`, composed with caller `AbortSignal` via `AbortSignal.any()`.
- **No host-internal vocabulary** — host-side bridge identifiers and bundled HTTP paths are explicitly absent from the published artefact (enforced by `scripts/check-no-bridge-strings.sh`, which scans the packed tarball during `prepublishOnly`).
- **MSW request manifest** — tests fail if any production URL drifts from a registered MSW handler.
- **Atomic, durable token persistence** — temp-file write + `fsync` + `rename` + parent-directory `fsync` (POSIX), with a final explicit `chmod 0600` on the token path; rotated tokens are cached in memory before the disk write so a persistence failure cannot lose Slack's single-use refresh token.
- **Refresh-failure differentiation** — distinct error codes for transient network errors, HTTP 429 rate-limits (with `retry_after_seconds`), Slack-side auth rejections (`invalid_grant` family — surfaces as `auth_required` so the host can dispatch reauth), and malformed responses.
- **Slack-owned download URL guard** — `download_slack_file` validates that the Slack-supplied `url_private_download` is HTTPS and on `slack.com` / `*.slack.com` before attaching the workspace bearer token, defending against tampered-API-response token-exfiltration.
- **Distinct token-file error states** — `loadTokens()` and the workspace listing distinguish missing / permission-denied / corrupt with separate codes so non-technical users get accurate remediation guidance instead of a misleading "fresh install" prompt.
