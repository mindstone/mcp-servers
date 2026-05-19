# @mindstone/mcp-server-replit-ssh

Replit SSH MCP server — read, write, list, and check files on Replit projects over SSH/SFTP, plus generate the local SSH key and config.

## Status

- **Version:** 0.1.0 · [npm](https://www.npmjs.com/package/@mindstone/mcp-server-replit-ssh)
- **Auth:** local SSH key on disk (`~/.ssh/rebel-replit` by default; resolved via `~/.ssh/config` IdentityFile if set)
- **Tools:** 5 (3 read + 2 write)
- **Surface:** SSH/SFTP to `*.replit.dev` hosts only

## Installation

```bash
npx -y @mindstone/mcp-server-replit-ssh
```

## Prerequisites

This server connects to live Replit projects over SSH, so the operator needs:

1. A Replit account with SSH access (Replit Core or higher).
2. A live `*.replit.dev` host from a Replit project (open the project, click "SSH" → "Connect" → "Connect manually", and copy the host + username from the displayed `ssh` command).
3. An SSH key registered with Replit at [replit.com/account#ssh-keys](https://replit.com/account#ssh-keys).

The bundled `replit_setup_ssh` tool generates an Ed25519 key at `~/.ssh/rebel-replit`, hardens the file permissions, and appends a `*.replit.dev` block to `~/.ssh/config`. Run it once if no SSH key exists yet, then add the printed public key to Replit. Alternatively, point the existing `~/.ssh/config` `IdentityFile` for `*.replit.dev` at an existing key and the server will use that instead.

## Configuration

This server has no required environment variables. Optional:

- `REPLIT_SSH_REQUEST_TIMEOUT_MS` — per-request timeout in milliseconds (default: 60000). Tool-level timeout for SFTP operations; the lower-level TCP/SSH handshake uses a separate 30-second budget.

## Tools

### Read

- `replit_check_connection` — verify SSH connectivity, working directory, and SFTP support. Set `verbose=true` for handshake/auth diagnostics.
- `replit_list_files` — list files and directories at a path (relative to the project root). Default path is `.`.
- `replit_read_file` — read a file. UTF-8 text by default; binary files (detected via null-byte scan) are returned as base64.

### Write

- `replit_write_file` — atomic write via `temp + ext_openssh_rename` with SHA-256 read-back verification. Fails closed if the server doesn't support atomic overwrite and the target already exists (we never `unlink + rename`, which opens a data-loss window).
- `replit_setup_ssh` — generate an Ed25519 key pair at `~/.ssh/rebel-replit`, write public/private files with mode `0600` (or `icacls` ACL on Windows), and append a `*.replit.dev` block to `~/.ssh/config`. Idempotent by default; pass `force_regenerate=true` to replace the existing key (you will need to re-register the new public key with Replit).

## Safety notes

- **Host allowlist.** Only `*.replit.dev` hosts are accepted, case-insensitive suffix match. Any other host is rejected before the SSH connection is opened.
- **`~/.ssh/` mutation surface.** `replit_setup_ssh` writes to the operator's home directory (`~/.ssh/rebel-replit`, `~/.ssh/rebel-replit.pub`, `~/.ssh/config`). Configuration rewrites use the `ssh-config` library's structured `parse`/`stringify` (not string splicing) so existing entries and comments are preserved.
- **Path traversal.** SFTP file paths are POSIX-normalized after rejecting absolute paths and any `..` segments — relative paths only, no escape from the project root.
- **Atomic write invariant.** `replit_write_file` writes to a randomized temp filename, renames via OpenSSH's POSIX rename extension (`ext_openssh_rename`), and verifies the final file's SHA-256 against the expected hash. If the server lacks the extension and the target file already exists, the write fails rather than falling back to `unlink + rename`.
- **Read-back verification.** Every `replit_write_file` re-reads the final file and asserts SHA-256 equality before returning `verified: true`.

## License

[FSL-1.1-MIT](./LICENSE)
