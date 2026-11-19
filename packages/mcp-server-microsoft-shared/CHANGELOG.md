# Changelog

All notable changes to this package are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- Token and accounts files are now read through a guarded reader: a symlink, a directory, FIFO or other non-regular file, a file whose opened identity differs from its path, or a file over 64 KiB is refused, and the JSON is schema-checked with Zod. A refused or corrupt file throws the new exported `MicrosoftCredentialFileError` (a fixed message naming no path or file content, plus a `reason` code) instead of a raw parse error that could quote the file; a corrupt `accounts.json` now raises it too rather than reading as no accounts. Missing files behave as before, every token shape the host writes still parses (including `expires_at: null` and extra keys), and `hasValidToken` still returns `false` rather than throwing. Adds a `zod` dependency.

## [0.1.1] - 2026-07-03

### Changed

- Redact email PII in logs, sanitize LOG_MODE, narrow token-load errors to ENOENT, harden atomicCredentialWrite (string|Buffer + pre-rename chmod); backward-compatible.

### Security

- Synced the vendored atomic credential-write helper to the upstream canonical copy: added `string | Buffer` data support and a temp-path `chmod` before rename. The existing `assertTargetIsNotSymlink` policy guard and guarded `O_NOFOLLOW` open flag are unchanged.
