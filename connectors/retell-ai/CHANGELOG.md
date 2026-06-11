# Changelog

## [Unreleased]

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
