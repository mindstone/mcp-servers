# Changelog

All notable changes to `@mindstone/mcp-server-replit-ssh` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-05-19

Initial public release. Migrated from the bundled `resources/mcp/replit-ssh/` connector in MindstoneRebel, ported to the `@mindstone/mcp-server-*` cohort shape (`McpServer` + `registerTool` + Zod).

### Added

- 5 tools (read, write, list, check connection, set up SSH key):
  - `replit_check_connection` — connect, echo a probe, return latency. Read-only.
  - `replit_list_files` — `ls -la`-equivalent on the Repl filesystem. Read-only.
  - `replit_read_file` — read a file from the Repl over SFTP. Read-only.
  - `replit_write_file` — write a file to the Repl over SFTP. Destructive write (`destructiveHint: true`).
  - `replit_setup_ssh` — generate `~/.ssh/rebel-replit{,.pub}` (ed25519) and append `Host *.replit.dev` directive to `~/.ssh/config`. Destructive on the local home directory.

- Cohort hygiene:
  - `SERVER_VERSION` is read from `package.json` via `createRequire` at runtime — no string sync between code and version.
  - Tool annotations: `destructiveHint: true` on `replit_write_file` and `replit_setup_ssh`; `openWorldHint: true` on every tool that touches the network.
  - Structured recovery contract on every tool error: `{ ok, error, code, action_required, next_step }`. 13 error codes defined in `src/errors.ts`.
  - `AbortSignal.any`-composed request timeout (60s default, configurable via `REPLIT_SSH_REQUEST_TIMEOUT_MS`, max 10 min). `sftpOpWithSignal` wraps ssh2's callback-only SFTP APIs to honour abort.

### Security

- **C1 (CRITICAL)**: replaced `ssh-config@5.1.0`'s `compute()` with a safe static AST evaluator (`src/configEvaluator.ts`). `compute()` evaluates `Match exec "<cmd>"` blocks by `spawnSync(cmd, { shell: true })`, which is local shell execution on every config parse — a vulnerability for any consumer that reads a user-controlled `~/.ssh/config`. The new evaluator walks `Host` sections only, skipping `Match` blocks entirely. Regression test (`test/configEvaluator.test.ts`) spies on `spawnSync` with a `Match exec` canary and asserts zero invocations.
- **M1**: `~/.ssh/config` rewrite is now atomic (temp file with `randomUUID()` + chmod 0o600 + fsync + rename + parent-dir fsync best-effort). Failure surfaces as `CONFIG_REWRITE_FAILED`.
- **M2**: Private-key writes are atomic with explicit `chmodSync(0o600)`; existing symlinks at the target are rejected with `KEY_WRITE_REJECTED_SYMLINK`. On Windows, `icacls` non-zero exit returns `PERMISSION_HARDENING_FAILED` (no log-and-continue); empty `USERNAME` returns `WINDOWS_USERNAME_MISSING`. 10s `execFileSync` timeout.

### Known Limitations

- **SSH host keys are not yet verified** (M3 from the round-1 security review, deferred). Connecting to a compromised network can expose file contents (data confidentiality + integrity); the local SSH private key is **not** exposed via this vector (public-key auth never transmits the key). Mitigations: avoid untrusted networks until TOFU + Replit fingerprint pinning lands (see `TODO.md`).
- **Multi-pattern Host blocks** (e.g. `Host *.replit.dev *.staging.replit.dev`) are silently ignored in this release (R2-m1; functional regression vs the bundled connector that used `ssh-config.compute()`). Users with multi-pattern blocks fall back to the default key path (`~/.ssh/rebel-replit`). Patch in 0.1.1.
- Five additional minor findings from the round-2 security review are tracked in `TODO.md` for 0.1.x: regression-test ESM mock brittleness, atomic-write `'wx'` flag, backup-filename randomisation, tilde-expansion containment.

### Internal

- Security review report: `MindstoneRebel/docs/reports/security-reviews/260519_bundled-replit-ssh_0.1.0.md` (round 1 BLOCK → round 2 APPROVE; named human sign-off 2026-05-19).
