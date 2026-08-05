# Changelog

All notable changes to this connector are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The history below `[Unreleased]` was reconstructed from git history during the
`@mindstone-engineering` to `@mindstone` npm scope migration; subsequent entries
are maintained manually as part of the PR review checklist.

## [Unreleased]

### Added
- **users**: New `update_talentlms_user` tool (POST `/edituser`) for updating name, email, login, password, bio, timezone, and deactivation date. Like `create_talentlms_user`, the `user_type` parameter is restricted to the non-privileged `Learner`/`Trainer` enum.
- **categories**: New `list_talentlms_categories` tool for browsing the course category tree.
- **reporting**: New `get_talentlms_leaderboard` tool (users ranked by gamification points, derived from the documented `points`/`level` user-list fields — the v1 API has no dedicated leaderboard endpoint) and `get_talentlms_user_certifications` tool (issued certifications with expiration dates, for compliance-expiry questions).
- **pagination**: `list_talentlms_users`, `list_talentlms_courses`, `list_talentlms_groups`, `list_talentlms_branches`, and `list_talentlms_categories` now accept `page_size` (max 1000) and `page_number` parameters, matching the v1 API's `page_size:N,page_number:M` colon-path pagination.

### Fixed
- **pagination**: List tools previously returned only the API's first page (20 items by default) with no way to fetch more, silently truncating tenants larger than one page.
- **client**: Removed an unverified "2,000-10,000 calls/hour" rate-limit figure from the 429 error message; TalentLMS publishes plan-dependent limits and a burst cap but no fixed per-plan figures.

### Security
- **FOX-3490**: External text returned by the TalentLMS API (course/group descriptions, user names, bios, custom fields, test/survey answers, site name, ILT instructor/location, and similar user-authored fields) is now wrapped in `<untrusted-content source="...">` envelopes with close-tag breakout escaping, so the host model treats third-party text as data rather than instructions. Ids, statuses, timestamps, scores, and URLs are intentionally left raw so tool chaining keeps working.
- **client**: Vendor error messages are enveloped before reaching model-visible error output, and the raw error body is never dumped into error text (a body echoing submitted values such as passwords can no longer leak). Unparseable response bodies fail closed with a connector-authored `INVALID_API_RESPONSE` error instead of propagating runtime parser fragments, and unexpected tool errors are logged to stderr while the model receives a sanitised generic message.
- **envelope**: External-text wrapping is now fail-closed: every string in an API payload is enveloped by default, and only narrowly proven system-generated primitives (grammar-validated ids, enums, numerics, dates, HTTPS URLs) pass through raw. Unknown or future vendor fields — and hostile values under structural-looking keys — can no longer bypass the envelope. The `get_talentlms_course_sso_link` response now goes through the same wrapping instead of being returned raw.

## [0.3.0] - 2026-07-01

### Changed

- Restrict create_talentlms_user user_type to a Learner/Trainer Zod enum, blocking prompt-injected creation of Administrator/SuperAdmin accounts (provision privileged roles in the TalentLMS UI).

### Security
- **users**: `create_talentlms_user` now restricts the `user_type` parameter to a Zod enum of non-privileged roles (`Learner`, `Trainer`). Previously the field accepted any string and forwarded it to TalentLMS, so prompt-injected tool input could create accounts with `Administrator` or `SuperAdmin` role. Administrator/SuperAdmin accounts must now be provisioned directly in the TalentLMS UI.

## [0.2.2] - 2026-05-14
### Added
- **registry**: Cohort A backfill — 12 API-key OSS connectors get server.json + mcpName. fathom, humaans, kling, mixmax, nano-banana, napkin, pandadoc, freshdesk, elevenlabs, retell-ai, runway, talentlms each gain a registry-shaped server.json (validated against registry.modelcontextprotocol.io) and an mcpName field on package.json under the io.github.mindstone namespace.

### Fixed
- **ci**: Add npm overrides for fast-uri, hono, ip-address across all connectors.

### Changed
- Republished under the `@mindstone` npm scope. The legacy `@mindstone-engineering/mcp-server-*` package on this version line will be deprecated as part of the FOX-3319 scope migration; see [MIGRATION.md](../../MIGRATION.md) for the procedure consumers should follow.

## [0.2.1] - 2026-04-29

### Fixed
- **talentlms**: Apply cohort sweep — read SERVER_VERSION from package.json (createRequire), add destructiveHint:true to mutating tools, add openWorldHint:true to remote-API tools (false on configure_*). Bump to 0.2.1. Mirrors retell-ai 92c9a40 fix to prevent SERVER_VERSION drift and align tool annotations across the cohort.

### Security
- **deps**: Bump vulnerable transitive deps to patched versions across all connectors. Resolves 52 dependabot moderate-severity alerts (27 hono, 22 postcss, 1 each @hono/node-server, esbuild, uuid).

## [0.2.0] - 2026-04-11

### Fixed
- **bridge**: clean brand references from batch2 connectors
- **ci**: add npm audit step, fix QBOQL injection, add validateHostname, standardize mock keys
- **ci**: standardize remaining mock API key fixtures to mcp-test-* pattern

## [0.1.0] - 2026-04-09

### Added
- **talentlms**: externalize TalentLMS MCP connector to standalone package


