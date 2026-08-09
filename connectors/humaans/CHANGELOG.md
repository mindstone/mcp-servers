# Changelog

All notable changes to this connector are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The history below `[Unreleased]` was reconstructed from git history during the
`@mindstone-engineering` to `@mindstone` npm scope migration; subsequent entries
are maintained manually as part of the PR review checklist.

## [Unreleased]

### Fixed

- Re-synced the vendored `<untrusted-content>` envelope helper with the canonical hardened reference: attribute-bearing close-tag variants (`</untrusted-content foo>`) and spoofed open tags inside wrapped content are now escaped, closing an envelope-breakout gap an LLM parser could read as an envelope boundary.

## [0.3.0] - 2026-08-07

### Changed

- Humaans connector: canonical result envelopes, untrusted-content fencing; expanded people/allocation/team actions.

### Added
- `list_humaans_time_away_allocations` — list time away allocations (the policy assignment behind each person's PTO balance), with `personId` filter and pagination.
- `cancel_humaans_time_away` — cancel a time away entry via `DELETE /api/time-away/:id`; annotated `destructiveHint: true`. Closes the create-without-cancel asymmetry.
- `approve_humaans_time_away` / `decline_humaans_time_away` — manager review workflow via `PATCH /api/time-away/:id` (`requestStatus` + optional `reviewNote`); annotated `destructiveHint: true`.
- `list_humaans_teams` — list team names with member counts, enabling the existing `team` filter on `list_humaans_people`. Humaans has no dedicated teams endpoint, so the list is derived by scanning the people directory (bounded at 2500 people, flagged `partial` beyond that).

### Security
- Envelope the free-text fields authored in Humaans — `note`/`reviewNote` on time-away entries and `note` on job roles — in `<untrusted-content>` wrappers (with close-tag breakout escaping) before they reach the model. These list/get responses previously returned the raw API objects unenveloped.
- Envelope the admin-authored `name` of embedded `timeAwayType` / `timeAwayPolicy` objects on time-away entries and allocations — external text that was still returned raw inside otherwise-sanitised responses.
- Envelope vendor API error bodies (JSON error messages and non-JSON bodies) before they reach the model, cap non-JSON bodies at 500 characters, and stop rendering wrong-shaped error JSON as `undefined (undefined): undefined`.
- Envelope the admin-authored type `name` on `list_humaans_time_away_types` — the same names already enveloped when embedded on time away entries; the dedicated list endpoint was returning them raw.
- Envelope the self-/manager-editable free-text fields on person profiles (`firstName`/`lastName`/`preferredName`, `bio`, social links, embedded team names, job title / department) returned by `get_humaans_me`, `get_humaans_person`, and `list_humaans_people`. Structured tokens (id, email, status, dates) stay raw so they remain usable as filter values.
- Envelope the admin-authored `label`/`city`/`country` on `list_humaans_locations` and the `name` on `get_humaans_company`.
- Envelope the admin-authored `jobTitle` / `department` returned by `list_humaans_job_roles` / `get_humaans_job_role`, and the `note` on a `jobRole` object embedded in person profiles — the same Humaans-authored strings the people tools already envelop; the job-roles endpoints were returning them raw.
- Parse the vendor-controlled `Retry-After` header to a non-negative integer before it reaches rate-limit messages; the raw header value no longer reaches the model.
- Guard the success-path JSON parse: a malformed 2xx response body now yields a static error message instead of leaking a snippet of the vendor-controlled body through the parser's error message.

## [0.2.2] - 2026-05-14
### Added
- **registry**: Cohort A backfill — 12 API-key OSS connectors get server.json + mcpName. fathom, humaans, kling, mixmax, nano-banana, napkin, pandadoc, freshdesk, elevenlabs, retell-ai, runway, talentlms each gain a registry-shaped server.json (validated against registry.modelcontextprotocol.io) and an mcpName field on package.json under the io.github.mindstone namespace.

### Fixed
- **ci**: Add npm overrides for fast-uri, hono, ip-address across all connectors.

### Changed
- Republished under the `@mindstone` npm scope. The legacy `@mindstone-engineering/mcp-server-*` package on this version line will be deprecated as part of the FOX-3319 scope migration; see [MIGRATION.md](../../MIGRATION.md) for the procedure consumers should follow.

## [0.2.1] - 2026-04-29

### Fixed
- **humaans**: Apply cohort sweep — read SERVER_VERSION from package.json (createRequire), add destructiveHint:true to mutating tools, add openWorldHint:true to remote-API tools (false on configure_*). Bump to 0.2.1. Mirrors retell-ai 92c9a40 fix to prevent SERVER_VERSION drift and align tool annotations across the cohort.

### Security
- **deps**: Bump vulnerable transitive deps to patched versions across all connectors. Resolves 52 dependabot moderate-severity alerts (27 hono, 22 postcss, 1 each @hono/node-server, esbuild, uuid).

## [0.2.0] - 2026-04-11

### Added
- **batch1**: add timeout tests for fathom/humaans/mixmax, add all 6 to CI matrix

### Fixed
- **batch1**: fix 5 blocking scrutiny issues from batch-1 review
- **batch1**: bridge error propagation for Fathom/Mixmax/PandaDoc + Zod-before-outbound proof for all 6
- **bridge**: clean brand references from template and batch1 connectors
- **ci**: add npm audit step, fix QBOQL injection, add validateHostname, standardize mock keys

## [0.1.0] - 2026-04-09

### Added
- **humaans**: externalize Humaans MCP connector to standalone package


