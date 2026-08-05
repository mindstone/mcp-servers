# Changelog

All notable changes to this connector are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `opus_download_clip` — download an exported clip MP4 (`uriForExport` URL)
  to a local file, with SSRF validation (HTTPS only, no private/loopback
  hosts, manual redirect handling with per-hop re-validation) and a
  workspace-confined write target.
- `MCP_WORKSPACE_PATH` declared in `server.json` (optional).

### Changed
- `opus_upload_video` now accepts the same typed preference schemas as
  `opus_create_project` (`curationPref`, `renderPref`, `importPref`,
  `uploadedVideoAttr`, `conclusionActions`) instead of untyped
  `z.record(z.unknown())` passthroughs.
- `renderPref` is now `.strict()` — unknown keys are rejected at schema
  level instead of being forwarded to the upstream API.
- `opus_publish_post` and `opus_schedule_post` are now annotated
  `destructiveHint: true` — publishing to a connected social account is a
  production-impacting write.
- `opus_upload_video`, `opus_create_project`, `opus_share_project`,
  `opus_create_collection`, and `opus_create_censor_job` are now also
  annotated `destructiveHint: true` — they create billable projects/jobs
  or change production visibility.
- `opus_get_clips` now surfaces upstream pagination completion metadata
  (`total`/`next`/`limit`) and echoes `pageNum`/`pageSize`, so a truncated
  page is distinguishable from a complete list. String `next` tokens are
  enveloped as upstream-controlled text.
- Poll responses (`opus_get_censor_job_status`, `opus_get_social_copy_job`)
  no longer include the raw `retry_after_header` field; use
  `next_poll_after_seconds`.
- Failed overwrite downloads no longer delete the pre-existing target
  file; cleanup only removes files the tool itself created.

### Fixed
- GCS resumable upload recovery: the HTTP client no longer auto-follows
  redirects (308 Resume Incomplete is a control signal the connector must
  see itself, and silently following redirects anywhere else bypasses
  destination validation), and `rawResponse` callers now receive non-2xx
  statuses instead of a collapsed `API_ERROR`, so the committed-offset
  query and GCS error-body surfacing actually execute.
- Upload opens now use `O_NONBLOCK`, so a FIFO swapped in at the source
  path is refused by the post-open `fstat` instead of blocking the open
  forever.

### Security
- `opus_upload_video` previously accepted ANY absolute filesystem path and
  uploaded it to Opus/GCS. Reads are now confined to `MCP_WORKSPACE_PATH`
  (or the system temp directory when unset) with canonical-prefix
  containment, symlink-escape rejection, and a structured
  `PATH_OUTSIDE_WORKSPACE` error. (AGENTS.md invariant #5.)
- External text returned by the Opus API — project/clip titles, brand
  template and collection names, social account display names, generated
  social copy (`title`/`description`/`hashtags`), upstream `error`/`message`
  strings, and raw debug dumps — is now wrapped in
  `<untrusted-content source="…">` envelopes with close-tag breakout
  escaping (AGENTS.md invariant #6).
- `opus_download_clip` writes are confined to the same workspace sandbox and
  never write through a symlink at the target path.
- Envelope coverage extended to every remaining upstream-controlled string:
  HTTP 422 and GCS resumable-upload error bodies, job `status` strings,
  the collections/`get_clips` `next` continuation tokens, unknown vendor
  fields carried by project objects (now enveloped unless they are a
  structural ID/URL/enum field), and unhandled-exception messages. The raw
  `Retry-After` header is no longer echoed in poll responses — only the
  parsed numeric `next_poll_after_seconds` is surfaced.
- Request logging no longer records full URLs (GCS signed/resumable URLs
  carry bearer-like query credentials) — only method, origin, and path —
  and vendor error bodies are no longer logged.
- Upload reads are bound to a single file descriptor: the validated path is
  opened once with `O_NOFOLLOW` + `O_NONBLOCK`, `fstat`-checked on the open
  descriptor, and every byte is read through that fd, so a post-validation
  path swap cannot redirect the upload.
- `opus_download_clip` opens its target with `O_NOFOLLOW`-equivalent flags
  plus a post-open `fstat` regular-file check, closing the
  check-then-open symlink/FIFO swap race (a raced-in symlink now fails
  with `OUTPUT_PATH_IS_SYMLINK` instead of being written through).
- Outbound URL validation (downloads and upstream-supplied GCS upload
  URLs) is now fail-closed: HTTPS without userinfo, refusal of the full
  non-public special-purpose registry (CGNAT, documentation, benchmarking,
  multicast/reserved, IPv6 link-local/unique-local, IPv4-mapped IPv6),
  an OpusClip/GCS host allow-list, and DNS resolution of hostnames with
  every resolved address re-checked (fail-closed on resolution failure),
  applied to the initial URL and every redirect hop.
- Upstream-supplied GCS initiation/session URLs are validated against the
  GCS host allow-list before use, so a poisoned Opus response cannot point
  the connector's fetch at an arbitrary host.

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
