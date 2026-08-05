# Changelog

## [Unreleased]

### Added
- **Chat read-side tools** — `list_chat_agents`, `list_chats`, and `get_chat`: read-only access to Retell's chat feature area. `list_chats` supports agent and start-time filters (mapped to Retell's typed operator objects; date strings coerce to epoch ms like `list_calls`). Chat transcripts, per-message content, and chat analysis are end-user-authored text and are wrapped in untrusted-content envelopes.
- **`get_concurrency`** — read the account's current/limit call concurrency (`GET /get-concurrency`) plus a derived `available_concurrency`, so the agent can sanity-check capacity before proposing a batch campaign or call burst.
- **Delete lifecycle tools** — `delete_agent`, `delete_retell_llm`, and `delete_phone_number`: permanent cleanup of agents, LLM configs (each deleting all versions), and phone numbers (releasing the number). All three are marked `destructiveHint: true`, and `delete_phone_number` E.164-validates locally before any request.
- **Knowledge base tools** — `list_knowledge_bases`, `get_knowledge_base`, `create_knowledge_base`, and `add_knowledge_base_sources`: ground voice agents on documents, URLs, and inline texts via Retell's RAG knowledge bases. Local file uploads (`file_paths`) are sandboxed to `MCP_WORKSPACE_PATH` (or the system temp directory when unset) with canonical-prefix containment — paths outside the sandbox, including symlinks that escape it, are rejected before any disk read. Knowledge-base names and source titles/filenames are wrapped in untrusted-content envelopes; source URLs are surfaced raw for the user.
- **`create_batch_call`** — schedule or start an outbound calling campaign (`POST /create-batch-call`): one `from_number` to a list of recipient tasks, each with optional per-call dynamic variables, metadata, and agent/version overrides. Supports `trigger_timestamp` scheduling (accepts epoch ms or a date string), `reserved_concurrency`, and `call_time_window` business-hours restrictions. Every recipient number is E.164-validated locally before any request reaches Retell's billing surface, and the tool is marked `destructiveHint: true` because every task is a real, billed phone call.

### Fixed
- **`list_agents` migrated off the deprecated endpoint**: Retell deprecated the legacy `GET /list-agents` in favour of the unified `POST /v2/list-agents` (voice + chat). The tool now calls `POST /v2/list-agents` with a voice-channel filter and returns paginated agent summaries (`pagination_key`, `has_more`), with optional `limit`, `sort_order`, and `pagination_key` parameters. Summary items also expose `voice_name` and `tags` (both wrapped in untrusted-content envelopes).

## [0.2.4] - 2026-06-11

### Changed

- Wrap all external-text tool output (transcripts, analysis, agent/LLM prose, agent versions) in untrusted-content envelopes — prompt-injection hardening (FOX-3490).

### Security
- **External call text is now wrapped in `<untrusted-content>` envelopes (FOX-3490)**: call transcripts, per-turn `transcript_object` content, and `call_analysis` text are dictated by the phone caller — the most attacker-controlled input this connector handles. These (plus agent names, Retell LLM prompts/opening messages, voice names, and phone-number nicknames) are now wrapped in `<untrusted-content source="…">…</untrusted-content>` envelopes before being returned to the model, with close-tag breakout escaping so a caller cannot terminate the envelope from inside their own speech. This closes a prompt-injection channel and brings the connector in line with the catalog-wide untrusted-content invariant. `recording_url` is left as-is (it is a URL surfaced for the user, not free text, and is never auto-followed).

## [0.2.3] - 2026-06-10

### Fixed
- **`list_calls` timestamp filters reject ISO date strings at strict hosts**: `filter_criteria.after_start_timestamp` / `before_start_timestamp` now advertise both number and string in the exported tool schema and coerce parseable date strings (e.g. `"2026-01-01"`) to epoch milliseconds at runtime. Strict MCP hosts validate against the exported schema before the connector runs, so the previous bare-number schema rejected such calls before the connector could coerce. Digit-only strings are accepted only in the unambiguous epoch-ms range (13-14 digits); Unix-seconds strings (e.g. `"1735689600"`), other ambiguous digit strings, and un-parseable strings are rejected with an actionable message.

### Changed
- Reworked `README.md` to explain when to choose this local Retell connector, what voice-agent workflows it helps with, and why call-changing actions need clear user review.

## [0.2.2] - 2026-05-20

### Added
- **Server-level MCP instructions**: Agents now receive a structured pre-call workflow and dynamic variable guidance on connection, reducing misuse of `retell_llm_dynamic_variables`.
- **`get_retell_llm` dynamic variable analysis**: Response includes a `dynamic_variable_analysis` field listing detected `{{variable_name}}` placeholders in the prompt, with an explicit warning when none are found explaining that dynamic variables will be silently dropped.
- **`create_phone_call` / `create_web_call` pre-call warnings**: Wired the existing `checkDynamicVariableReferences` validation into both call tools. When passed dynamic variables don't match prompt placeholders, the response includes actionable warnings (while still placing the call).
- Pre-call check source (`precall-checks.ts`) and tests committed (previously developed but not included in 0.2.1 publish).

### Improved
- `retell_llm_dynamic_variables` parameter descriptions on `create_phone_call` and `create_web_call` now warn that unmatched variables are silently dropped.

## [0.2.1] - 2026-05-14

### Changed
- Republished under the `@mindstone` npm scope. The legacy `@mindstone-engineering/mcp-server-*` package on this version line will be deprecated as part of the FOX-3319 scope migration; see [MIGRATION.md](../../MIGRATION.md) for the procedure consumers should follow.

## [0.2.0] - 2026-05-10

### Fixed
- **`create_phone_call` 404 errors**: Fixed endpoint URL from `/create-phone-call` to `/v2/create-phone-call` (Retell API moved call endpoints to v2)
- **`create_web_call` 404 errors**: Fixed endpoint URL from `/create-web-call` to `/v2/create-web-call`
- **`get_call` 404 errors**: Fixed endpoint URL from `/get-call/` to `/v2/get-call/`
- **`list_calls` deprecation**: Migrated from `/v2/list-calls` to `/v3/list-calls` (Retell deprecating v2 on 2026-06-15)
- **`list_phone_numbers` deprecation**: Migrated from `/list-phone-numbers` to `/v2/list-phone-numbers`
- **`list_retell_llms` deprecation**: Migrated from `/list-retell-llms` to `/v2/list-retell-llms`

### Added
- **`override_agent_version`** parameter on `create_phone_call` — specify agent version (integer or tag like "latest") to avoid 404s when phone number binding points to wrong version
- **`agent_version`** parameter on `create_web_call`
- **`stop_call`** tool — stop an ongoing call immediately
- **`publish_agent`** tool — publish a draft agent version to make it live (fixes 404s from unpublished versions)
- **`get_agent_versions`** tool — list all versions of an agent to debug version issues
- **`get_phone_number`** tool — inspect a phone number's agent bindings
- **`update_phone_number`** tool — rebind agents to phone numbers using the new weighted agent list format (March 2026 Retell migration)
- Pagination support (`limit`, `pagination_key`) on `list_calls`, `list_phone_numbers`, `list_retell_llms`
- Additional `update_agent` parameters: `voice_speed`, `responsiveness`, `interruption_sensitivity`, `enable_backchannel`, `ambient_sound`, `boosted_keywords`
- `model_temperature` parameter on `update_retell_llm`
- 402 (payment required) and 409 (conflict) error resolution guidance

### Improved
- All tool descriptions enriched with COMMON MISTAKES, RELATED TOOLS, RETURNS field lists, EXAMPLE JSON, and error recovery guidance
- Updated model options to current Retell catalog (gpt-4.1, gpt-5, gpt-5.5, claude-4.5-sonnet, claude-4.6-sonnet, gemini-3.0-flash, etc.)
- Tool count: 15 → 20

## [0.1.3] - 2026-04-29

Initial release with 15 tools: create_phone_call, create_web_call, get_call, list_calls, get_agent, list_agents, create_agent, update_agent, update_retell_llm, get_retell_llm, create_retell_llm, list_retell_llms, list_voices, list_phone_numbers, configure_retell_api_key.
