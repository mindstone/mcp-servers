# Changelog

All notable changes to this connector are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-05-19

### Added
- Initial public release covering the full documented OpusClip API surface.
- 21 tools across configure, brand templates, project lifecycle, GCS resumable
  upload, censor jobs, collections, collection contents, and social posting.
- Single-tool orchestration of the 4-step GCS resumable upload with
  query-committed-offset recovery on ambiguous failures and idempotent
  project creation.
- `pollOpusJob` shared async-job helper with `Retry-After` parsing (seconds
  and HTTP-date) and explicit `next_poll_after_seconds` in responses.
- `UPSTREAM_STATUS_UNKNOWN` observable failure mode for unrecognised job
  statuses (no silent collapse to `pending`).
- Split timeouts: `OPUS_API_TIMEOUT_MS`, `OPUS_UPLOAD_TIMEOUT_MS`,
  `OPUS_BRIDGE_TIMEOUT_MS`.
- Optional host-app bridge (`MCP_HOST_BRIDGE_STATE`) with three distinct
  failure modes (unavailable / unreachable / auth-failed).
