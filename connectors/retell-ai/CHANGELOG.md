# Changelog

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
