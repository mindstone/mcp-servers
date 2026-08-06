# Changelog

All notable changes to `@mindstone/mcp-server-replit-ssh` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- `replit_check_connection` now wraps every peer-authored field it returns in
  `<untrusted-content>` envelopes: the server version, the working directory
  (SFTP realpath response), and all diagnostic event details (server banner,
  keyboard-interactive prompts, handshake/debug/error text) — including on
  the failure path, where diagnostics are returned unconditionally.
- The known-hosts store now accepts OpenSSH `ssh-keyscan` output
  (`<host> <keytype> <base64-key>`, computing the SHA-256 fingerprint from
  the key) in addition to native `SHA256:…` fingerprint lines, so the
  documented `MCP_REPLIT_SSH_STRICT_HOST_KEY=1` pre-population flow actually
  works. Comment, marker (`@…`), and hashed-host (`|1|…`) lines are ignored.
- Host-key pins are now recorded and matched by the stable proxy suffix
  (first DNS label stripped, e.g. `riker.replit.dev`) instead of the
  rotating per-project hostname. Previously every Replit project restart
  produced a fresh unknown host and a silent fresh TOFU accept, so the
  fail-closed mismatch branch — the real MitM defence — was rarely
  exercised; suffix entries also make `ssh-keyscan riker.replit.dev` pins
  apply to every project behind that proxy.
- The known-hosts append path now refuses to write through a symlinked
  known-hosts file (failing closed with `HOST_KEY_RECORD_FAILED`), matching
  the symlink guard the private-key write path already had.
- Migrated the untrusted-content envelope helper to the canonical shared implementation: close-tag breakout escaping now neutralises case and horizontal-whitespace variants (`</UNTRUSTED-CONTENT>`, `</untrusted-content >`, tab variants), not just the exact lowercase no-whitespace spelling.

### Added

- `replit_search_files` — recursive search over SFTP by file-name substring
  and/or text-content substring (case-insensitive). Content matches return
  line numbers and the matching lines; binary files and files over 1 MB are
  skipped for content search. Bounded by `max_results` (default 50, max 200),
  `max_depth` (default 4, max 10), and a global visited-entry cap, with a
  `truncated` flag when a cap is hit. Matched paths and lines are wrapped in
  `<untrusted-content>` envelopes like the other read tools.
- `replit_stat` — file/directory metadata (type, size, permissions,
  mtime/atime) without reading file contents.
- `replit_move` — move or rename a file or directory. Pre-checks the
  destination and fails with `DESTINATION_EXISTS` instead of overwriting.
- `replit_delete_file` — permanently delete a file (files only; directories
  are refused). Carries `destructiveHint: true` and additionally requires the
  `MCP_REPLIT_SSH_ALLOW_DELETE=1` environment opt-in, failing closed with
  `DELETE_DISABLED` otherwise, because deletion on Replit is irreversible
  (no trash). Declared in `server.json`.

### Fixed

- `replit_read_file` — files over 1 MiB are now refused with `FILE_TOO_LARGE`
  (checked via stat before reading, with a post-read length check as backstop)
  instead of being buffered unbounded into memory; the cap matches the one
  `replit_search_files` already applies to content search.
- `~/.ssh/config` evaluation — negated `Host` patterns (`Host *.replit.dev
  !secret.replit.dev`) are now honoured per OpenSSH semantics: a host matching
  a `!`-pattern never selects that block's `IdentityFile`. Previously the `!`
  was treated as a literal character (and space-separated pattern lists were
  dropped entirely), so a block could apply to hosts the config excluded.
- `replit_write_file` — `encoding: "base64"` content is now validated
  strictly and rejected when malformed, instead of letting Node's decoder
  silently discard invalid characters (which wrote corrupted bytes while the
  read-back verification still reported `verified: true`). Line-wrapping
  whitespace is tolerated.
- `replit_move` — tool annotations no longer claim `idempotentHint: true`;
  a repeated move fails with `DESTINATION_EXISTS` rather than no-oping, so
  advertising idempotence was wrong.
- `replit_list_files` — symlinks are now reported as `type: "symlink"`
  instead of being mislabeled `file`, consistent with `replit_stat`'s
  lstat-based typing (SFTP `readdir` returns lstat-style attributes).
- `replit_search_files` — per-file content line matches are now capped at 5;
  a file with more matching lines carries `lineMatchesTruncated: true` on the
  match instead of returning an unbounded list (a hot file with the needle on
  every line could previously flood the tool response).
- `replit_stat` — symlinks are now reported as `type: "symlink"` with the
  link's own metadata (via `lstat`) instead of silently describing the link
  target.

## [0.1.2] - 2026-05-20

### Security

- **replit-ssh-001 (CRITICAL)** — closed the SSH host-key verification gap
  documented in the 0.1.0 "Known Limitations". `ssh2.Client.connect()` now
  passes an explicit `hostVerifier` callback that pins server keys via the
  trust-on-first-use store in `src/hostVerification.ts`. The default
  behaviour matches OpenSSH's `StrictHostKeyChecking=accept-new`, which
  is the value the misleading `~/.ssh/config` line was already
  (falsely) advertising:
  - **First contact with an unknown host**: the SHA-256 fingerprint of
    the presented host key is recorded to a per-user known-hosts file
    (`$MCP_REPLIT_SSH_KNOWN_HOSTS_PATH` → `$MCP_WORKSPACE_PATH/.replit-ssh-known-hosts`
    → `$HOME/.replit-mcp/known_hosts`), mode 0o600. A notice is logged
    to stderr and the connection proceeds.
  - **Subsequent contact**: the recorded fingerprint is compared against
    the presented fingerprint. A mismatch ALWAYS fails closed with
    `HOST_KEY_MISMATCH` — strict-on-rotation policy detects an active
    MitM that appears after first contact.
  - **Strict-mode opt-in**: setting `MCP_REPLIT_SSH_STRICT_HOST_KEY=1`
    causes unknown hosts to fail closed with `HOST_KEY_UNKNOWN`.
    Operators who want fail-closed first-contact pre-populate the
    known-hosts file out-of-band (e.g. via
    `ssh-keyscan riker.replit.dev` from a trusted network).
  - **Misleading `~/.ssh/config` line removed**: the setup tool no
    longer appends `StrictHostKeyChecking accept-new`. The MCP server
    uses node-`ssh2`, not OpenSSH, so that directive was cosmetic but
    suggested host verification was happening when it was not. The
    `Host *.replit.dev` block (Port + IdentityFile) still helps users
    who run the OpenSSH CLI directly.
  - **Algorithm allow-list**: outbound `client.connect()` now restricts
    the negotiated kex/host-key/cipher/HMAC algorithms to the
    curve25519/ed25519/AEAD/ETM set defined in
    `SSH_ALGORITHM_ALLOWLIST` — blocks downgrade negotiation to weaker
    suites.

  Existing users do NOT need to change their configuration: the default
  is auto-record-then-pin, equivalent to the OpenSSH `accept-new`
  behaviour that the old config line claimed. The CRITICAL finding
  ("any host key accepted, no fingerprint recorded, no mismatch
  detection") is closed because the connector now computes, stores,
  and strictly compares fingerprints on every connect.

  Regression tests in `test/host-verification.test.ts` cover: auto-TOFU
  first-contact record, mode-0o600 file creation, subsequent-connect
  match, fingerprint-mismatch reject (with and without strict mode),
  case-insensitive host matching, strict-mode unknown-host reject,
  strict-mode acceptance of pre-populated entries, the algorithm
  allow-list shape, and the removal of the misleading
  `StrictHostKeyChecking accept-new` line from `setup.ts`.

- **replit-ssh-006** — file content read via `replit_read_file` and
  directory-entry names from `replit_list_files` are now wrapped in
  `<untrusted-content source="…">…</untrusted-content>` envelopes per
  AGENTS.md invariant #6. The wrapper escapes any embedded close-tag so
  an attacker who controls file contents on the remote cannot
  break out of the envelope to forge model instructions. Regression tests
  in `test/untrusted-content.test.ts`.

## [0.1.1] - 2026-05-19

### Documentation

- Rewrote `README.md` to follow the structure in [`docs/CONNECTOR_README_GUIDE.md`](../../docs/CONNECTOR_README_GUIDE.md): added npm-version and licence badges, an italic positioning line, the `## Status` block with hyperlinked evidence and `Hosts tested` / `Machine-readable` rows, a `## Why this exists` section, a `## Example interaction` block, `## Host configuration examples` (Claude Desktop / Cursor and local development), the `(5)` tool count in the `## Tools` heading, and renamed `## Installation` → `## Quick Start` (with the three prescribed code blocks) and `## Prerequisites` → `## Requirements` to match the rest of the cohort.
- Added the connector to the table in the repo-root `README.md`.

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
