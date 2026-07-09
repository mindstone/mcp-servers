# Changelog

All notable changes to this connector are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **elevenlabs-agents**: Stage 5 scaffold from `connectors/_template/`, renamed and cleaned of placeholders, with `server.json.name` aligned to `package.json.mcpName` and `STATUS.json` schema v2.
- **elevenlabs-agents**: read-side Stage 5 tools — `configure_elevenlabs_agents_api_key`, `list_agents`, `get_agent`, `list_conversations`, `get_conversation`, `get_conversation_audio`, `list_phone_numbers`, `get_phone_number`, `list_knowledge_base_docs`, `get_knowledge_base_doc`.
- **elevenlabs-agents**: `src/endpoints.ts` with the verified `/v1/convai/*` surface, plus ElevenLabs-style auth/bridge/client/error-detail wiring and vendored `file-input.ts` + `path-safety.ts` for the later KB upload stage.
- **elevenlabs-agents**: Retell-style `src/sanitize.ts` covering agent names/prompts, conversation transcripts and analysis, phone labels, and knowledge-base names/content; KB content is capped to about 50KB with explicit truncation metadata.
- **elevenlabs-agents**: Stage 6 telephony tools — `update_phone_number`, `make_outbound_call`, `submit_batch_call`, `list_batch_calls`, `get_batch_call`, `cancel_batch_call`, and `retry_batch_call`, including the connector’s differentiating `scheduled_time_unix` batch capability that the official ElevenLabs MCP does not expose.

### Security
- **elevenlabs-agents**: ships `<untrusted-content>` envelopes from day one for every model-visible external text field on the read-side surface, including the highest-risk caller-controlled transcript content. Adds breakout tests, mechanical envelope-reachability checks, and source-level guards asserting the read tools reach `sanitize.ts` / `wrapUntrusted`.
- **elevenlabs-agents**: outbound and batch calling reject malformed E.164 numbers before any upstream request; `scheduled_time_unix` accepts epoch seconds or ISO strings, rejects millisecond-looking inputs, and fails closed on past times with `INVALID_SCHEDULED_TIME`.
