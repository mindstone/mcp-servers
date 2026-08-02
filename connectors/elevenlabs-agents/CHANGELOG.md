# Changelog

All notable changes to this connector are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- Agent and knowledge-base responses now envelope external text deny-by-default, matching the conversation and phone-number surfaces. Previously an allowlist of field names was used, so current API fields authored by any workspace collaborator — `agents[].access_info.creator_name` and `documents[].dependent_agents[].name` — reached the model unenveloped.
- Responses that are not valid JSON now fail with a connector-authored `INVALID_RESPONSE` error. The parser's own message quotes the leading response bytes, which put unenveloped third-party text into a model-visible error.

## [0.1.1] - 2026-07-11

### Fixed

- Fix empty/incorrect tool input schemas: expose editable fields on `update_agent`, `update_phone_number`, and `add_knowledge_base_document`; add required `agent_id` to `make_outbound_call`; add a schema-contract test that asserts the SDK-exposed JSON schemas for write tools.

## [0.1.0] - 2026-07-09

### Changed

- Initial release: ElevenLabs Conversational-AI agents — authoring, conversations & transcripts, knowledge base, phone numbers, and batch/scheduled outbound calling.

### Added
- **elevenlabs-agents**: Stage 5 scaffold from `connectors/_template/`, renamed and cleaned of placeholders, with `server.json.name` aligned to `package.json.mcpName` and `STATUS.json` schema v2.
- **elevenlabs-agents**: read-side Stage 5 tools — `configure_elevenlabs_agents_api_key`, `list_agents`, `get_agent`, `list_conversations`, `get_conversation`, `get_conversation_audio`, `list_phone_numbers`, `get_phone_number`, `list_knowledge_base_docs`, `get_knowledge_base_doc`.
- **elevenlabs-agents**: `src/endpoints.ts` with the verified `/v1/convai/*` surface, plus ElevenLabs-style auth/bridge/client/error-detail wiring and vendored `file-input.ts` + `path-safety.ts` for the later KB upload stage.
- **elevenlabs-agents**: Retell-style `src/sanitize.ts` covering agent names/prompts, conversation transcripts and analysis, phone labels, and knowledge-base names/content; KB content is capped to about 50KB with explicit truncation metadata.
- **elevenlabs-agents**: Stage 6 telephony tools — `update_phone_number`, `make_outbound_call`, `submit_batch_call`, `list_batch_calls`, `get_batch_call`, `cancel_batch_call`, and `retry_batch_call`, including the connector’s differentiating `scheduled_time_unix` batch capability that the official ElevenLabs MCP does not expose.
- **elevenlabs-agents**: Stage 7 authoring and KB-write tools — `create_agent`, `update_agent`, `duplicate_agent`, `delete_agent`, `simulate_conversation`, `add_knowledge_base_document`, and `delete_knowledge_base_document`, including the first-class authoring field map plus `advanced_config` deep-merged last.

### Security
- **elevenlabs-agents**: ships `<untrusted-content>` envelopes from day one for every model-visible external text field on the read-side surface, including the highest-risk caller-controlled transcript content. Adds breakout tests, mechanical envelope-reachability checks, and source-level guards asserting the read tools reach `sanitize.ts` / `wrapUntrusted`.
- **elevenlabs-agents**: outbound and batch calling reject malformed E.164 numbers before any upstream request; `scheduled_time_unix` accepts epoch seconds or ISO strings, rejects millisecond-looking inputs, and fails closed on past times with `INVALID_SCHEDULED_TIME`.
- **elevenlabs-agents**: simulated transcripts, updated-agent prompt surfaces, and KB-write responses now stay under the same `<untrusted-content>` envelope discipline as the read-side tools, backed by reachability and annotation assertions for the new Stage 7 surface.
