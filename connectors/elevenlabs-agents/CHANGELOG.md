# Changelog

All notable changes to this connector are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `import_phone_number` and `delete_phone_number` tools, completing the telephony lifecycle: a Twilio number (Account SID + Auth Token) or SIP trunk number (inbound/outbound trunk config) can now be onboarded and later removed without leaving the agent loop. Numbers are E.164-validated before any upstream call; both tools carry `destructiveHint: true`.
- `submit_conversation_feedback` tool: submits like/dislike feedback for a reviewed conversation, closing the quality-review loop against `POST /convai/conversations/{id}/feedback`.
- `get_knowledge_base_rag_index_status` and `rebuild_knowledge_base_rag_index` tools: after uploading a knowledge-base document, agents can now check whether retrieval indexing has finished and trigger (re)indexing when it has not, instead of guessing when a document becomes retrievable.
- `list_agent_tools` and `add_agent_tool` tools: workspace tools (webhook and client) can now be inventoried and created, so webhook wiring — the feature that makes ConvAI agents act on external systems — no longer requires the ElevenLabs dashboard. `add_agent_tool` fails closed when a webhook tool is missing its URL, accepts an `advanced_config` passthrough for the full platform schema, and carries `destructiveHint: true`.

### Fixed

- README Status section no longer claims a bootstrap placeholder version `0.0.0`; it now points at the released version and changelog, matching the sibling connectors.

## [0.1.2] - 2026-08-03

### Changed

- Land the tools/list schema fix on main and envelope all ElevenLabs response text deny-by-default (closes prompt-injection paths); route API-key setup to connector settings.

### Security

- Agent and knowledge-base responses now envelope external text deny-by-default, matching the conversation and phone-number surfaces. Previously an allowlist of field names was used, so current API fields authored by any workspace collaborator — `agents[].access_info.creator_name` and `documents[].dependent_agents[].name` — reached the model unenveloped.
- Responses that are not valid JSON now fail with a connector-authored `INVALID_RESPONSE` error. The parser's own message quotes the leading response bytes, which put unenveloped third-party text into a model-visible error.
- Outbound-call and batch-call responses now envelope external text deny-by-default as well, and the field-name allowlist is gone from the connector entirely. It omitted `agent_name` and `branch_name` — fields the current ElevenLabs batch-call responses carry and any workspace collaborator can author — so an instruction-shaped agent name reached the model unenveloped through `list_batch_calls` / `get_batch_call`. Every response surface now shares one walk, so a prose field added upstream is enveloped from the day it first appears.
- Responses whose root is a bare JSON value rather than the expected object are now enveloped too. An HTTP 200 body of `"… SYSTEM: …"` parses as valid JSON, and the agent, knowledge-base, simulation, outbound-call and batch-call sanitizers previously returned such values unchanged — so the deny-by-default walk never ran and the text reached the model raw. The same applied to list bodies whose items were bare strings.
- Transcript fields that arrive in an unexpected shape are enveloped as well. `{"simulated_conversation": "… SYSTEM: …"}` is a valid HTTP 200 body with an ordinary object root, so the root guard above never saw it, and the transcript walk returned any non-array value unchanged — `simulate_conversation` then handed the text to the model raw. No sanitizer in this connector now returns an upstream value unchanged because its container had an unexpected shape; the test suite enumerates the sanitizer module's exports at runtime and fails if a new one does.

### Fixed

- The agent authoring tools (`create_agent`, `update_agent`, `duplicate_agent`, `simulate_conversation`) now strip one `<untrusted-content>` envelope from the values they receive. Reading an agent returns its configuration enveloped, so copying a value — a language, an LLM model id, a system prompt, or a whole `advanced_config` fragment — straight back into an update previously stored the envelope upstream as the agent's real configuration. Responses are still enveloped; only the write path unwraps.

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
