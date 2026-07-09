# Changelog

All notable changes to this connector are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The history below `[Unreleased]` was reconstructed from git history during the
`@mindstone-engineering` to `@mindstone` npm scope migration; subsequent entries
are maintained manually as part of the PR review checklist.

## [Unreleased]

### Added
- **elevenlabs**: Five multipart file-input tools — `speech_to_speech` (voice conversion, multipart field `audio`), `isolate_audio` (background noise removal), `forced_alignment` (audio+transcript alignment with enveloped `words[].text`), `clone_voice` (instant voice clone from sandboxed local files), `delete_voice` (permanent voice removal, `destructiveHint: true`). Shared `src/tools/file-input.ts` extracts the path-sandbox invariants from transcription (R1).
- **elevenlabs**: `search_shared_voices` gains verified `accent` filter param.
- **elevenlabs**: Four FREE discovery/account tools — `check_subscription` (tier + character credits + reset), `list_models` (model capabilities and languages), `get_voice` (single-voice detail), `search_shared_voices` (public library with search/filters). All external-text fields enveloped; shared-voice names/descriptions treated as highest-care third-party content.
- **elevenlabs**: `src/endpoints.ts` centralises every API path (v1 + v2 voices) for one-line fixes.
- **elevenlabs**: Retell-style tool descriptions across all 17 tools (WHEN TO USE / EXAMPLE / RELATED TOOLS / RETURNS / COST-or-FREE) within the description-budget soft cap; mechanical smoke assertion for the complete D-ANNOTATIONS per-tool table.

### Changed
- **elevenlabs**: Error resolutions for quota/credits now cross-reference `check_subscription`; `VOICE_NOT_FOUND` resolutions point at `list_voices` and `search_shared_voices`. HTTP 422 resolutions now include enveloped flattened field paths for self-correction (F3).
- **elevenlabs**: API error `detail` strings from 401/403/422 bodies are enveloped in model-visible error messages via shared `error-detail.ts` (FastAPI field-path flattening preserved inside the envelope).

### Security
- **elevenlabs**: Wrap all API-authored text in `<untrusted-content>` envelopes with close-tag breakout escaping (AGENTS.md security invariant #6, FOX-3490 remediation): `list_voices` voice names/descriptions/label values, `transcribe_audio` transcript text, and the API-resolved voice name returned by `generate_speech`. Human-readable `message` strings no longer echo any API-authored substrings (the `generate_speech` message now reports only the saved file path). Composition plans from `create_music_plan` remain unwrapped as a considered exclusion — they are model-generated from the user's own prompt and must round-trip verbatim into `generate_music_from_plan`. Ships a vendored `src/untrusted-content.ts` (byte-identical to the shared template helper) plus envelope-presence, close-tag-breakout, and mechanical envelope-reachability tests; the connector is removed from the repo untrusted-coverage baseline (ratchet-down).

## [0.3.0] - 2026-05-20

Triggered by a real conversation where `generate_music_from_plan` returned
HTTP 422 and the agent shipped an instrumental song the user did not ask for.
Live-captured the real ElevenLabs API shapes for plan/music/TTS/STT and brought
every input schema, default, and error path back into spec. See
`docs/plans/260520_elevenlabs_oss_connector_fix.md` in MindstoneRebel for the
full trace.

### Fixed
- **elevenlabs**: `generate_music_from_plan` schema mismatch (the bug behind the original conversation). Sections previously accepted `{ style, lyrics, duration_ms }`, which the API rejects with HTTP 422. The schema now requires `{ section_name, duration_ms, positive_local_styles, negative_local_styles, lines }` exactly as returned by `create_music_plan`. Legacy `{ style, lyrics }` shape is rejected at the Zod boundary with a clear error instead of falling through to a 422.
- **elevenlabs**: `transcribe_audio` was sending multipart field name `audio` without `model_id` — the API rejects with HTTP 422 "model_id required". Field renamed to `file`, `model_id` defaulted to `scribe_v1`, `tag_audio_events` defaulted to `false` (matching Rebel's main-app convention to avoid `(mouse click)` style transcripts).
- **elevenlabs**: `generate_speech` default voice was hardcoded "Rachel", which silently failed on accounts without it. Now picks the first premade voice on the account (falls back to first available, errors clearly when the account has zero voices).
- **elevenlabs**: 422 FastAPI validation arrays were thrown away and surfaced as `HTTP 422: unknown`. Now flattened into `body.<field.path>: <msg>; ...` so agents can self-correct from the error message alone.
- **elevenlabs**: 401 responses for missing scopes (e.g. `sound_generation`) were masked as generic "Authentication failed". Now surfaced as `MISSING_PERMISSION` with the API's own message and resolution hint pointing to the API key settings page.
- **elevenlabs**: `force_instrumental: true` combined with `[Verse]/[Chorus]` markers in the prompt silently dropped vocals. The tool description now warns explicitly, and `generate_music` emits a `warnings[]` entry when both are present so the agent can self-correct.

### Added
- **elevenlabs**: TTS model enum now includes `eleven_v3` (new default), `eleven_flash_v2_5`, `eleven_turbo_v2_5` alongside the prior `eleven_multilingual_v2` and `eleven_monolingual_v1`.
- **elevenlabs**: `transcribe_audio` now exposes optional `model_id` and `tag_audio_events` inputs (defaults `scribe_v1` / `false`).
- **elevenlabs**: `generate_music_from_plan` schema validates total duration is between 3s and 10min at the Zod layer.
- **elevenlabs**: Composition schemas are `.strict()` — unknown keys are rejected at the boundary instead of being silently stripped (prevents accidental legacy-shape submissions).
- **elevenlabs**: 11 new tests covering the verbatim plan round-trip, legacy-shape rejection, multipart transcription shape, voice-fallback variants (premade / cloned-only / generated-only), force_instrumental warning, 422 array detail flattening, malformed 422 entries, and the new MISSING_PERMISSION path.

### Changed
- **elevenlabs**: `generate_speech` default `model_id` changed from `eleven_multilingual_v2` to `eleven_v3`.

## [0.2.2] - 2026-05-14
### Added
- **registry**: Cohort A backfill — 12 API-key OSS connectors get server.json + mcpName. fathom, humaans, kling, mixmax, nano-banana, napkin, pandadoc, freshdesk, elevenlabs, retell-ai, runway, talentlms each gain a registry-shaped server.json (validated against registry.modelcontextprotocol.io) and an mcpName field on package.json under the io.github.mindstone namespace.
- **registry**: cohort review fixes + Office REBEL_OFFICE_* → MCP_OFFICE_* rename + browser-automation mcpName.

### Fixed
- **elevenlabs**: sandbox transcribe_audio file paths under MCP_WORKSPACE_PATH (M3.9)
- **elevenlabs**: canonical-prefix sandbox check + ENOENT classification (M3-fix-C)
- **ci**: Add npm overrides for fast-uri, hono, ip-address across all connectors.

### Changed
- Republished under the `@mindstone` npm scope. The legacy `@mindstone-engineering/mcp-server-*` package on this version line will be deprecated as part of the FOX-3319 scope migration; see [MIGRATION.md](../../MIGRATION.md) for the procedure consumers should follow.

## [0.2.1] - 2026-04-29

### Fixed
- **elevenlabs**: Apply cohort sweep — read SERVER_VERSION from package.json (createRequire), add destructiveHint:true to mutating tools, add openWorldHint:true to remote-API tools (false on configure_*). Bump to 0.2.1. Mirrors retell-ai 92c9a40 fix to prevent SERVER_VERSION drift and align tool annotations across the cohort.

### Security
- **deps**: Bump vulnerable transitive deps to patched versions across all connectors. Resolves 52 dependabot moderate-severity alerts (27 hono, 22 postcss, 1 each @hono/node-server, esbuild, uuid).

## [0.2.0] - 2026-04-11

### Fixed
- **batch2**: fix 4 blocking scrutiny issues for ElevenLabs and Nano Banana
- **bridge**: clean brand references from batch2 connectors
- **oss**: standardize mock API key patterns in elevenlabs and runway test fixtures
- **ci**: add npm audit step, fix QBOQL injection, add validateHostname, standardize mock keys

## [0.1.0] - 2026-04-09

### Added
- **elevenlabs**: externalize ElevenLabs MCP connector to standalone package


