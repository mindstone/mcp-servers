# Changelog

All notable changes to this connector are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The history below `[Unreleased]` was reconstructed from git history during the
`@mindstone-engineering` to `@mindstone` npm scope migration; subsequent entries
are maintained manually as part of the PR review checklist.

## [Unreleased]

### Added
- `download_kling_video` — save generated videos/images to local disk before the 30-day URL expiry. Output is sandboxed to the download root (default `<workspace>/kling-downloads`; `KLING_DOWNLOAD_ROOT` may redirect it within the workspace) with lexical + realpath containment, a sensitive-path deny-list, symlink refusal at the target, atomic no-clobber writes (opt-in `overwrite`), Kling-host-only SSRF validation, and manual redirect following with per-hop revalidation.
- `generate_kling_image_to_video` now accepts a local image file via `image_path` (previously a public HTTPS URL was mandatory). Local reads are confined to `MCP_WORKSPACE_PATH` (or the system temp directory) with canonical-prefix containment that refuses symlink escape; jpg/jpeg/png up to 10MB are sent to Kling as base64.
- `extend_kling_video` — continue a generated video (~4-5s per extension) via `/videos/video-extend`.
- `generate_kling_lip_sync` — lip-sync a video from text (`text2video` mode, requires `text` + `voice_id`) or an audio file (`audio2video` mode, `audio_url` or workspace-fenced `audio_path`) via `/videos/lip-sync`.
- `generate_kling_image` — text-to-image generation via `/images/generations`, with optional reference image (URL or workspace-fenced local file), negative prompt, aspect ratio, and 1-9 outputs.
- `list_kling_tasks` — paginated task listing per task type; returns only IDs, status, timestamps, and result URLs (prompts echoed in `task_info` are deliberately not surfaced).
- `get_kling_balance` — resource-package list with remaining quantities via `GET /account/costs`.
- `callback_url` (HTTPS) is now supported on all generation tools (`generate_kling_video`, `generate_kling_image_to_video`, `extend_kling_video`, `generate_kling_lip_sync`, `generate_kling_image`) so hosts can receive webhook notifications instead of polling.

### Changed
- `check_kling_task` accepts all task types (`text2video`, `image2video`, `video-extend`, `lip-sync`, `image`), returns image URLs for image tasks, and surfaces the generated video `id` needed by `extend_kling_video` and `generate_kling_lip_sync`.

### Security
- All Kling API responses are now validated fail-closed with Zod (envelope + per-endpoint `data` schema); malformed JSON or a shape-drifting payload surfaces as a generic `INVALID_RESPONSE` error instead of an unchecked type cast or raw parser text.

### Fixed
- `list_kling_tasks` no longer silently truncates: the output now includes `has_more` plus `next_page` (and a continuation hint) whenever the returned page is full, so the model can tell that more results exist. The tool description no longer promises an ordering the vendor does not guarantee.
- Credit-consuming production writes (`generate_kling_video`, `generate_kling_image_to_video`, `extend_kling_video`, `generate_kling_lip_sync`, `generate_kling_image`) now carry `destructiveHint: true` — they create vendor jobs and spend account credits, and were previously annotated `destructiveHint: false`.
- `klingFetch` no longer sends the bearer JWT to arbitrary absolute URLs: only the exact Kling API origin is accepted (the `/account/costs` endpoint at the domain root keeps working).
- Vendor-supplied error messages are credential-redacted (access key, secret key, and the live JWT) and wrapped in `<untrusted-content>` envelopes before they can reach model-visible output.
- Every vendor-controlled string in tool output — task IDs, video IDs, result URLs, durations, `task_status_msg`, and resource-pack name/type/status — is now wrapped in an `<untrusted-content>` envelope with close-tag breakout escaping (invariant #6). Tools unwrap their own enveloped IDs/URLs when passed back as input, so chaining `generate_*` → `check_kling_task` → `download_kling_video` keeps working.
- Unknown (non-`KlingError`) exceptions no longer echo raw runtime messages to the model; they are logged credential-redacted to stderr and reported as a generic error.
- `check_kling_task` now returns a `videos` array with every video the vendor returned (previously only index zero was surfaced as a singular `video`).
- Local media reads no longer stat-then-reopen by pathname: the validated file is opened once with `O_NOFOLLOW`, `fstat`-verified as a regular file within the size limit, and read through that same descriptor, closing the swap race between validation and read.
- `download_kling_video` opens its output with numeric flags including `O_NOFOLLOW` (plus `O_NONBLOCK` on overwrite) and `fstat`-verifies the opened object, so a symlink or special file planted at the target between the pre-checks and the open is refused instead of written through.
- Download output is now confined to the same canonical roots as local reads: the download root defaults to `<workspace>/kling-downloads` (was `~/Downloads/kling-mcp`), and a configured `KLING_DOWNLOAD_ROOT` must resolve inside the workspace (`MCP_WORKSPACE_PATH`, or the system temp directory when unset) — an out-of-workspace value is refused fail-closed with guidance instead of silently widening the write surface.
- `download_kling_video` only fetches Kling result URLs: the URL host must be `klingai.com` or a subdomain (hard-coded, not env-overridable), URLs with embedded credentials are refused, and the private/reserved IP checks now also cover CGNAT, TEST-NET, benchmark, multicast/reserved, and IPv4-mapped IPv6 ranges. Redirect error messages no longer echo the `Location` URL, so signed query strings cannot leak into model output.

## [0.3.2] - 2026-05-14
### Added
- **registry**: Cohort A backfill — 12 API-key OSS connectors get server.json + mcpName. fathom, humaans, kling, mixmax, nano-banana, napkin, pandadoc, freshdesk, elevenlabs, retell-ai, runway, talentlms each gain a registry-shaped server.json (validated against registry.modelcontextprotocol.io) and an mcpName field on package.json under the io.github.mindstone namespace.

### Fixed
- **ci**: Add npm overrides for fast-uri, hono, ip-address across all connectors.

### Changed
- Republished under the `@mindstone` npm scope. The legacy `@mindstone-engineering/mcp-server-*` package on this version line will be deprecated as part of the FOX-3319 scope migration; see [MIGRATION.md](../../MIGRATION.md) for the procedure consumers should follow.

## [0.3.1] - 2026-04-29

### Fixed
- **kling**: Apply cohort sweep — read SERVER_VERSION from package.json (createRequire), add destructiveHint:true to mutating tools, add openWorldHint:true to remote-API tools (false on configure_*). Bump to 0.3.1. Mirrors retell-ai 92c9a40 fix to prevent SERVER_VERSION drift and align tool annotations across the cohort.

### Security
- **deps**: Bump vulnerable transitive deps to patched versions across all connectors. Resolves 52 dependabot moderate-severity alerts (27 hono, 22 postcss, 1 each @hono/node-server, esbuild, uuid).

## [0.3.0] - 2026-04-21

### Added
- **connectors**: Harden request timeouts across 4 long-running generation connectors. Follows nano-banana-v0.3.0 (139d488) — same hard-coded 30s timeout class of bug applies to polling-style generation APIs.

## [0.2.0] - 2026-04-11

### Fixed
- **batch1**: fix 5 blocking scrutiny issues from batch-1 review
- **batch1**: bridge error propagation for Fathom/Mixmax/PandaDoc + Zod-before-outbound proof for all 6
- **bridge**: clean brand references from batch2 connectors

## [0.1.0] - 2026-04-09

### Added
- **kling**: externalize Kling MCP connector to standalone package


