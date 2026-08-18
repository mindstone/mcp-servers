# Changelog

All notable changes to this connector are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The history below `[Unreleased]` was reconstructed from git history during the
`@mindstone-engineering` to `@mindstone` npm scope migration; subsequent entries
are maintained manually as part of the PR review checklist.

## [Unreleased]

## [0.5.2] - 2026-08-18

### Changed

- Signpost the arbitrary auto-picked default voice via a voice_note and clearer param descriptions instead of silently choosing a language-blind default

## [0.5.1] - 2026-08-10

### Changed

- Fail-closed response schemas for all unchecked-cast sites, spec-nullability hardening, and empty voice-design-id rejection.

### Fixed
- The remaining unchecked response casts are now Zod-validated fail-closed (`INVALID_RESPONSE` on shape drift), completing response-schema coverage for every tool: `get_dubbing` (a non-string `status`/`target_languages` entry previously crashed the envelope helper with a raw `TypeError`), `list_models` (a non-array payload previously degraded to `ok` with `count: 0`), `list_voices`, `get_voice`, `search_shared_voices` (and the `generate_speech` voice-lookup helpers), `create_music_plan` (a non-numeric `duration_ms` previously poisoned the total-duration arithmetic), `forced_alignment`, and `design_voice`.
- `design_voice` preview `audio_base_64` is now grammar-gated as canonical base64 before the artifact write — `Buffer.from(x, 'base64')` silently discards invalid characters, so an unvalidated payload could write a truncated or empty file reported as success.
- `list_models` now envelopes the API-authored `language_id` (display-only, same treatment as `list_history` `model_id`). `model_id` stays raw: it is a round-trip handle for `generate_speech`, whose own input schema gates it against a closed enum — the same raw-ID stance as `voice_id`/`dubbing_id`.
- The new response schemas tolerate explicit `null` for spec-`Optional` fields (FastAPI serializes `None` as `null`, not omission) — a successful `get_dubbing` poll (`"error": null`) or a voice without a generated preview (`"preview_url": null`) no longer risks a false-positive `INVALID_RESPONSE` — and `design_voice` again rejects an empty `generated_voice_id`, matching the pre-schema truthiness guard.

- Re-synced the vendored `<untrusted-content>` envelope helper with the canonical hardened reference: attribute-bearing close-tag variants (`</untrusted-content foo>`) and spoofed open tags inside wrapped content are now escaped, closing an envelope-breakout gap an LLM parser could read as an envelope boundary.

## [0.5.0] - 2026-08-07

### Changed

- ElevenLabs connector: canonical result envelopes, untrusted-content fencing, and hardening sync; expanded TTS/voice actions.

### Security
- `clone_voice`, `create_voice_from_preview`, and `create_dubbing` responses are now Zod-validated fail-closed (`INVALID_RESPONSE` on shape drift) instead of unchecked casts, and their API-authored IDs (`voice_id` / `dubbing_id`) are no longer interpolated into the `message` / `poll_hint` prose — they are returned as structured fields only (the same stance `get_dubbing` already takes for `status`). A non-numeric `expected_duration_sec` no longer leaks into the poll-guidance prose either.
- `get_dubbing` now envelopes the API-authored `status` and `target_languages` fields (enum-like but not validated against a closed grammar — the same stance as `list_history` `model_id`/`source`), and the unvalidated `status` is no longer interpolated into the `message` prose; the lifecycle classification is carried by `is_terminal` and `next_step` instead.
- `check_subscription` responses are now Zod-validated fail-closed (`INVALID_RESPONSE` on shape drift) instead of an unchecked cast: character counts must be finite numbers, and `next_character_count_reset_unix` is bounded so the ISO-date conversion cannot throw on an extreme finite upstream value.
- A 200 response with a non-JSON body now surfaces a structured `INVALID_RESPONSE` error instead of the runtime's JSON parse error, whose message embeds an excerpt of the raw upstream body.
- Generated and downloaded artifacts (speech/sound-effect/dialogue audio, history and dubbing downloads, with-timestamps audio/alignment/SRT, voice-design previews) now write inside the canonical `MCP_WORKSPACE_PATH` root — falling back to `os.tmpdir()` only when it is unset — via the same canonical-prefix containment used for file reads, instead of always landing in the host temp directory.
- Artifact writes use exclusive creation (`O_EXCL`, no symlink follow): a pre-existing destination — regular file or symlink — is rejected rather than overwritten, and multi-artifact writes (`generate_speech_with_timestamps` audio + alignment + SRT) remove earlier artifacts if a later write fails, so no partial set survives.
- `get_usage_stats` identifies the credits-denominated column ONLY via an explicit `credits` entry in the API's `column_units` (never by column-name fallback), envelopes usage column names, group values, and row strings, and fails closed with a structured error — never `ok` with a zeroed total — when no column or several columns are credits-denominated, the requested group column is missing, a row is malformed, or a credits value is non-numeric, non-finite, or negative.
- External API responses consumed by `transcribe_audio` (transcript, word timings, speaker identifiers), the pronunciation dictionary tools (list/get/add), and `get_usage_stats` are now Zod-validated fail-closed (`INVALID_RESPONSE` on shape drift) instead of unchecked casts; validation errors report field paths only and never echo upstream values.
- `list_history` and `generate_speech_with_timestamps` responses are likewise Zod-validated fail-closed: history items must carry a string `history_item_id` and a plausible `date_unix` (bounded so the ISO-date conversion cannot throw on an extreme finite value), and with-timestamps responses must contain valid canonical base64 audio plus alignment arrays matching the character count with finite, non-negative, non-decreasing start AND end timestamps. Validation happens before any artifact is written to disk.
- `transcribe_audio` validates the API-authored `speaker_id` against a genuinely closed grammar (documented `speaker_N` diarization labels) and envelopes the API-detected `language_code` as untrusted content — a BCP-47-shaped grammar gate is not a trust boundary, since it still admits instruction-shaped hyphenated text (e.g. `en-ignore-all-rules`). A caller-supplied `language_code` continues to be echoed as-is.
- `list_history` now envelopes the API-authored `source`, `model_id`, and `content_type` fields, and `get_pronunciation_dictionary` envelopes the API-returned rule `alphabet`. The `add_pronunciation_dictionary` phoneme-rule `alphabet` input is now an allow-listed enum (`ipa`, `arpabet`) instead of any non-empty string.
- Pronunciation dictionary responses are validated as a discriminated union on rule `type`: an `alias` rule must carry `alias`, a `phoneme` rule must carry `phoneme` and `alphabet` — a response that omits the payload its type promises is rejected (`INVALID_RESPONSE`). The API-authored `permission_on_resource` field is now enveloped like name and description.

### Fixed
- `check_subscription` no longer drops a legitimate `next_character_count_reset_unix` of `0` (admitted by the response schema): the ISO reset field is now emitted for it.
- A response body read that aborts or times out mid-stream now surfaces `TIMEOUT` with retry guidance instead of being mislabelled as a non-JSON ("API response format may have changed") error.
- `get_usage_stats` no longer reports a minutes-denominated `total_usage` column as credits, silently zeroes numeric-string values, pads short rows with nulls, or labels missing group values as `unknown`.
- `transcribe_audio` now rejects `num_speakers` / `diarization_threshold` when `diarize` is not `true` (previously accepted and forwarded), and the `num_speakers` + `diarization_threshold` conflict is rejected too — both before any network request is made.

### Added
- `transcribe_audio` gains speaker diarization (`diarize`, `num_speakers`, `diarization_threshold`) and word-level timestamps (`timestamps_granularity`, `include_word_timestamps`), plus the `scribe_v2` model option. Diarized output is grouped into per-speaker `utterances[]` with enveloped text.
- `list_history` and `get_history_item_audio` (FREE) — browse past generations and re-download their audio without regenerating.
- `get_usage_stats` (FREE) — credit usage over time via the workspace analytics API (`POST /v1/workspace/analytics/query/usage-by-product-over-time`, the successor of the deprecated `GET /v1/usage/character-stats`), grouped by product type, model, voice, or user.
- Pronunciation dictionary suite: `list_pronunciation_dictionaries` / `get_pronunciation_dictionary` (FREE) and `add_pronunciation_dictionary` / `archive_pronunciation_dictionary` (both `destructiveHint: true`; archiving is reversible in the dashboard).
- `generate_speech_with_timestamps` — TTS via `/v1/text-to-speech/{voice_id}/with-timestamps`; writes the audio file, the raw character-alignment JSON, and an `.srt` subtitle file built from word timing.
- `generate_speech` gains optional `seed` and `pronunciation_dictionary_locators` params.

## [0.4.0] - 2026-07-11

### Changed

- Expand to 24 tools: voice discovery, subscription/credits, speech-to-speech, isolation, forced alignment, cloning, voice design, text-to-dialogue, dubbing; untrusted-content + sandbox hardening.

### Added
- **elevenlabs**: Stage 4 slow/async audio tools — `text_to_dialogue` (multi-voice dialogue, 120s timeout), `design_voice` + `create_voice_from_preview` (voice design; base64 previews decoded to tmp files, never returned in output), and dubbing suite `create_dubbing` / `get_dubbing` / `download_dubbed_audio` / `delete_dubbing` (v1 async submit→poll→download; Content-Type-sniffed downloads; `delete_dubbing` `destructiveHint: true`). `client.ts` gains optional per-call `timeoutMs` (R2; default unchanged).
- **elevenlabs**: Five multipart file-input tools — `speech_to_speech` (voice conversion, multipart field `audio`), `isolate_audio` (background noise removal), `forced_alignment` (audio+transcript alignment with enveloped `words[].text`), `clone_voice` (instant voice clone from sandboxed local files), `delete_voice` (permanent voice removal, `destructiveHint: true`). Shared `src/tools/file-input.ts` extracts the path-sandbox invariants from transcription (R1).
- **elevenlabs**: `search_shared_voices` gains verified `accent` filter param.
- **elevenlabs**: Four FREE discovery/account tools — `check_subscription` (tier + character credits + reset), `list_models` (model capabilities and languages), `get_voice` (single-voice detail), `search_shared_voices` (public library with search/filters). All external-text fields enveloped; shared-voice names/descriptions treated as highest-care third-party content.
- **elevenlabs**: `src/endpoints.ts` centralises every API path (v1 + v2 voices) for one-line fixes.
- **elevenlabs**: Retell-style tool descriptions across all 17 tools (WHEN TO USE / EXAMPLE / RELATED TOOLS / RETURNS / COST-or-FREE) within the description-budget soft cap; mechanical smoke assertion for the complete D-ANNOTATIONS per-tool table.

### Changed
- **elevenlabs**: Error resolutions for quota/credits now cross-reference `check_subscription`; `VOICE_NOT_FOUND` resolutions point at `list_voices` and `search_shared_voices`. HTTP 422 resolutions now include enveloped flattened field paths for self-correction (F3).
- **elevenlabs**: API error `detail` strings from 401/403/422 bodies are enveloped in model-visible error messages via shared `error-detail.ts` (FastAPI field-path flattening preserved inside the envelope).

### Security
- **elevenlabs**: Wrap all API-authored text in `<untrusted-content>` envelopes with close-tag breakout escaping (AGENTS.md security invariant #6, FOX-3490 remediation): `list_voices` voice names/descriptions/label keys and values, `create_music_plan` model-generated free-text fields, `transcribe_audio` transcript text, and the API-resolved voice name returned by `generate_speech`. Human-readable `message` strings no longer echo any API-authored substrings (the `generate_speech` message now reports only the saved file path). Music plans returned for display are unwrapped by `generate_music_from_plan` before strict validation and API submission. Ships a vendored `src/untrusted-content.ts` (byte-identical to the agents connector vendored helper) plus envelope-presence, close-tag-breakout, and mechanical envelope-reachability tests; the connector is removed from the repo untrusted-coverage baseline (ratchet-down).

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

