# Changelog

All notable changes to this package are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-07-03

### Changed

- Redact email PII in logs, sanitize LOG_MODE, narrow token-load errors to ENOENT, harden atomicCredentialWrite (string|Buffer + pre-rename chmod); backward-compatible.

### Security

- Synced the vendored atomic credential-write helper to the upstream canonical copy: added `string | Buffer` data support and a temp-path `chmod` before rename. The existing `assertTargetIsNotSymlink` policy guard and guarded `O_NOFOLLOW` open flag are unchanged.
