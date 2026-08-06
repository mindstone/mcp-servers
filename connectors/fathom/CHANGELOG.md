# Changelog

All notable changes to this connector are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The history below `[Unreleased]` was reconstructed from git history during the
`@mindstone-engineering` to `@mindstone` npm scope migration; subsequent entries
are maintained manually as part of the PR review checklist.

## [Unreleased]

### Added
- **fathom**: New `get_fathom_action_items` tool — aggregates action items across meetings with the same server-side filters as `list_fathom_meetings`, returning open items by default (`include_completed` opt-in) with meeting context, assignee, and recording playback links. `get_fathom_meeting` now returns action items alongside the summary, and `list_fathom_meetings` gains an `include_action_items` flag mapping to the upstream query parameter.
- **fathom**: New recording download tools — `request_fathom_recording_download` starts async download generation (`POST /recordings/{id}/download`) and `get_fathom_recording_download_status` polls it for the short-lived signed URL.
- **fathom**: New webhook management tools — `create_fathom_webhook` (HTTPS destination URL, payload content flags, `destructiveHint: true`) and `delete_fathom_webhook` — enabling post-meeting automations such as pushing action items into other systems.

### Changed
- **fathom**: Caller-controllable text returned by all tools (meeting titles, invitee/recorder names, AI summaries, transcript lines and speaker names, action item descriptions, team and member names) is now wrapped in `<untrusted-content>` envelopes so hosts treat meeting content as data, not instructions. Connector-controlled metadata (ids, timestamps, URLs, emails) is unchanged.

### Fixed
- **fathom**: 429 rate-limit responses are now retried up to 3 times, honouring the `Retry-After` header (capped at 60s) with exponential-backoff fallback, before surfacing a `RATE_LIMITED` error.
- **fathom**: server.json now declares the optional `MCP_HOST_BRIDGE_STATE` / `MINDSTONE_REBEL_BRIDGE_STATE` bridge env vars that `src/bridge.ts` reads.

### Security
- **fathom**: All external text is enveloped via the shared `wrapUntrusted` helper (vendored `src/untrusted-content.ts`) with close-tag breakout escaping, remediating the FOX-3490 untrusted-content baseline gap.
- **fathom**: Vendor API error bodies and unhandled-error messages (which can embed response-body fragments) are now truncated and wrapped in `<untrusted-content>` envelopes before reaching model-visible tool errors.

## [0.2.3] - 2026-05-14
### Added
- **registry**: Cohort A backfill — 12 API-key OSS connectors get server.json + mcpName. fathom, humaans, kling, mixmax, nano-banana, napkin, pandadoc, freshdesk, elevenlabs, retell-ai, runway, talentlms each gain a registry-shaped server.json (validated against registry.modelcontextprotocol.io) and an mcpName field on package.json under the io.github.mindstone namespace.

### Fixed
- **ci**: Add npm overrides for fast-uri, hono, ip-address across all connectors.

### Changed
- Republished under the `@mindstone` npm scope. The legacy `@mindstone-engineering/mcp-server-*` package on this version line will be deprecated as part of the FOX-3319 scope migration; see [MIGRATION.md](../../MIGRATION.md) for the procedure consumers should follow.

## [0.2.2] - 2026-04-29

### Added
- **fathom**: add get_fathom_meeting_participants tool

### Fixed
- **fathom**: Apply cohort sweep — read SERVER_VERSION from package.json (createRequire), add destructiveHint:true to mutating tools, add openWorldHint:true to remote-API tools (false on configure_*). Bump to 0.2.2. Mirrors retell-ai 92c9a40 fix to prevent SERVER_VERSION drift and align tool annotations across the cohort.

### Security
- **deps**: Bump vulnerable transitive deps to patched versions across all connectors. Resolves 52 dependabot moderate-severity alerts (27 hono, 22 postcss, 1 each @hono/node-server, esbuild, uuid).

## [0.2.1] - 2026-04-14

### Fixed
- **fathom**: Remove unused fathom-typescript dependency (no license on npm). The dependency was listed but never imported — the connector uses a direct HTTP client instead. Eliminates legal risk from an unlicensed third-party package.

## [0.2.0] - 2026-04-11

### Added
- **batch1**: add timeout tests for fathom/humaans/mixmax, add all 6 to CI matrix

### Fixed
- **batch1**: fix 5 blocking scrutiny issues from batch-1 review
- **batch1**: bridge error propagation for Fathom/Mixmax/PandaDoc + Zod-before-outbound proof for all 6
- **bridge**: clean brand references from batch2 connectors
- **ci**: add npm audit step, fix QBOQL injection, add validateHostname, standardize mock keys

## [0.1.0] - 2026-04-09

### Added
- **fathom**: externalize Fathom MCP connector to standalone package


