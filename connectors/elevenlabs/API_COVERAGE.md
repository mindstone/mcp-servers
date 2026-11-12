# ElevenLabs API coverage

Generated from the explicit operation policy. Admission describes the new API interface; existing coverage is an independent assessment of the unchanged ordinary and Agents packages.

Source: https://api.elevenlabs.io/openapi.json
Retrieved: 2026-11-08T21:07:54.389549+00:00
SHA-256 (original decompressed bytes): `794bccdc06ac77a90e576807fac9d00204f5af6bba115a84bfd71ace208c11dc`
Source census: 375 paths; 515 HTTP operation IDs; 2,675,026 bytes.

Partition: **40 admitted + 366 planned + 109 excluded = 515**.

Numeric milestones: 1 (40), 7 (134), 8 (35), 9 (131), 10 (66). Version 0.6.0 is proposed for the first interface only; no release is authorized and later versions are unset.

Only admitted descriptors and their reachable component graph enter the generated catalogue. Seven registered API tools expose local discovery and six execution profiles for the 40 admitted operations, alongside the unchanged ordinary 32 definitions (39 total). The separate Agents package is unchanged. Reserved run_job and place_call tools are unregistered.

Public consistency tests validate the committed policy, catalogue, ledger and explicitly pinned miniature fixtures. Public CI does **not** possess or validate the whole upstream snapshot. Full-source generation and --check require an explicit local JSON or gzip input matching the pinned original bytes; the whole source is neither committed nor included in npm. No runtime fetch occurs.

Regenerate from the connector directory: `npm run api:generate -- --spec <pinned.json-or-gzip>`. Verify with `npm run api:check -- --spec <pinned.json-or-gzip>`. Both commands verify the immutable production source pin.

Provider constraints (including enums, required fields, maps and open objects) are preserved. Only synthesized path/query records are closed. Forbidden aliases are exact anchored own-property checks described in the compatibility overlay, separate from discovery search aliases. Enum errors refer to the 2026-11-08 snapshot and recommend a reviewed catalogue refresh.

Document uploads bind only multipart field `file` as a document. File requiredness is separate from scalar multipart fields; create-file uses the existing long request timeout category. Document uploads use document MIME types with application/octet-stream fallback, regular-file and descriptor identity checks, and the runtime buffer size limit. Provider format and account limits still apply. The legacy audio MIME fallback is unchanged.

Saved Tests can spend credits and invoke real integrations. No implicit mocks, retries, polling, attachment merges or cleanup are authorized. Knowledge retrieval can spend credits but creates no conversation. Host permission bands determine authority; these annotations are not a host rating.

Ajv and ajv-formats are direct dependencies so the validator interprets the retained schema graph directly with strict, non-mutating validation and full standard formats; zoneinfo uses Intl. They are existing locked dependencies promoted to direct dependencies, not a claim that Zod cannot represent unions or recursion.

## Exclusions

- account_and_keys: 9. Credential administration belongs in the provider dashboard.
- engineering: 4. Documentation or deprecated routes with explicitly described replacements.
- identity_and_seats: 10. Identity, membership and seat administration belongs in the provider dashboard.
- productions: 11. Production orders and charging belong in the provider dashboard.
- reception: 75. Separate receptionist and reseller commercial product.

Deprecated upload replacement: create a file **or URL** document, preserving optional name; optional attachment requires get_agent_route followed by an explicit caller-authored patch_agent_settings_route with existing structured locators plus the new locator. The document response model is the same; inputs and atomic behavior differ. No automatic read/merge/write or cleanup is implied.

## Exact operation ledger

| Operation ID | Method | Path | Status | Milestone | Family | Profile | Existing coverage | Existing package:tool references | Reason / replacements |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| accept_merge_proposal_route | POST | /v1/convai/agents/{agent_id}/merge-proposals/{merge_proposal_id}/merge | planned | 7 | agents | — | missing | — | No existing tool maps to this exact HTTP operation. |
| add_chapter | POST | /v1/studio/projects/{project_id}/chapters | planned | 10 | studio | — | missing | — | No existing tool maps to this exact HTTP operation. |
| add_documentation_to_knowledge_base | POST | /v1/convai/knowledge-base | excluded | — | knowledge-base | — | not-worth-exposing | — | Deprecated upload accepts file or URL, optional name and optional agent attachment, and returns AddKnowledgeBaseResponseModel. Create a file or URL document with optional name; for attachment, read the agent and explicitly patch caller-authored structured knowledge_base locators including existing locators and the new locator. Multi-step replacement differs in inputs and atomic behavior; no automatic GET/merge/PATCH or cleanup. Documentation or deprecated routes with explicitly described replacements. Replacement IDs: create_file_document_route, create_url_document_route, get_agent_route, patch_agent_settings_route |
| add_from_file | POST | /v1/pronunciation-dictionaries/add-from-file | planned | 9 | pronunciation-dictionaries | — | missing | — | No existing tool maps to this exact HTTP operation. |
| add_from_rules | POST | /v1/pronunciation-dictionaries/add-from-rules | planned | 9 | pronunciation-dictionaries | — | partial | @mindstone/mcp-server-elevenlabs:add_pronunciation_dictionary | Supports name, description and rules; provider workspace permission options are not exposed. |
| add_language | POST | /v1/dubbing/resource/{dubbing_id}/language | planned | 9 | dubbing | — | missing | — | No existing tool maps to this exact HTTP operation. |
| add_mcp_server_tool_approval_route | POST | /v1/convai/mcp-servers/{mcp_server_id}/tool-approvals | planned | 7 | mcp-servers | — | missing | — | No existing tool maps to this exact HTTP operation. |
| add_mcp_tool_config_override_route | POST | /v1/convai/mcp-servers/{mcp_server_id}/tool-configs | planned | 7 | mcp-servers | — | missing | — | No existing tool maps to this exact HTTP operation. |
| add_member | POST | /v1/workspace/groups/{group_id}/members | excluded | — | identity_and_seats | — | not-worth-exposing | — | Identity, membership and seat administration belongs in the provider dashboard. |
| add_merge_proposal_comment_route | POST | /v1/convai/agents/{agent_id}/merge-proposals/{merge_proposal_id}/comments | planned | 7 | agents | — | missing | — | No existing tool maps to this exact HTTP operation. |
| add_project | POST | /v1/studio/projects | planned | 10 | studio | — | missing | — | No existing tool maps to this exact HTTP operation. |
| add_pvc_voice_samples | POST | /v1/voices/pvc/{voice_id}/samples | planned | 9 | voices | — | missing | — | No existing tool maps to this exact HTTP operation. |
| add_rules | POST | /v1/pronunciation-dictionaries/{pronunciation_dictionary_id}/add-rules | planned | 9 | pronunciation-dictionaries | — | missing | — | No existing tool maps to this exact HTTP operation. |
| add_sharing_voice | POST | /v1/voices/add/{public_user_id}/{voice_id} | planned | 9 | voices | — | missing | — | No existing tool maps to this exact HTTP operation. |
| add_ticket_comment_route | POST | /v1/convai/triage-tickets/{agentqa_ticket_id}/comments | planned | 7 | triage-tickets | — | missing | — | No existing tool maps to this exact HTTP operation. |
| add_tool_route | POST | /v1/convai/tools | admitted | 1 | tools | create | partial | @mindstone/mcp-server-elevenlabs-agents:add_agent_tool | Builds selected tool_config variants with local URL and schema validation; does not express every provider tool variant and option. |
| add_turn_comment_route | POST | /v1/convai/triage-tickets/{agentqa_ticket_id}/turn-comments | planned | 7 | triage-tickets | — | missing | — | No existing tool maps to this exact HTTP operation. |
| add_voice | POST | /v1/voices/add | planned | 9 | voices | — | covered | @mindstone/mcp-server-elevenlabs:clone_voice | Supports all current multipart fields: name, files, remove_background_noise, description and JSON-encoded labels. |
| add_voice_to_user_voice_collection | POST | /v1/voices/collections/{collection_id}/voice/{voice_id} | planned | 9 | voices | — | missing | — | No existing tool maps to this exact HTTP operation. |
| agent_testing_bulk_move_route | POST | /v1/convai/agent-testing/bulk-move | planned | 7 | agent-testing | — | missing | — | No existing tool maps to this exact HTTP operation. |
| assign_conversation_tags_route | POST | /v1/convai/conversations/{conversation_id}/tags | planned | 7 | conversations | — | missing | — | No existing tool maps to this exact HTTP operation. |
| audio_isolation | POST | /v1/audio-isolation | planned | 9 | audio-isolation | — | partial | @mindstone/mcp-server-elevenlabs:isolate_audio | Supports multipart audio; does not expose all current provider request controls or history/stream variants. |
| audio_isolation_stream | POST | /v1/audio-isolation/stream | planned | 9 | audio-isolation | — | missing | — | No existing tool maps to this exact HTTP operation. |
| audio_native_project_update_content_endpoint | POST | /v1/audio-native/{project_id}/content | planned | 10 | audio-native | — | missing | — | No existing tool maps to this exact HTTP operation. |
| audio_native_update_content_from_url | POST | /v1/audio-native/content | planned | 10 | audio-native | — | missing | — | No existing tool maps to this exact HTTP operation. |
| cancel_batch_call | POST | /v1/convai/batch-calling/{batch_id}/cancel | planned | 8 | batch-calling | — | partial | @mindstone/mcp-server-elevenlabs-agents:cancel_batch_call | Cancels by batch_id on the exact endpoint. |
| cancel_crawl_job_route | POST | /v1/convai/knowledge-base/crawl/{crawl_job_id}/cancel | planned | 7 | knowledge-base | — | missing | — | No existing tool maps to this exact HTTP operation. |
| cancel_file_upload_route | DELETE | /v1/convai/conversations/{conversation_id}/files/{file_id} | planned | 7 | conversations | — | missing | — | No existing tool maps to this exact HTTP operation. |
| cancel_test_invocation_route | POST | /v1/convai/test-invocations/{test_invocation_id}/cancel | admitted | 1 | test-invocations | tests | missing | — | No existing tool maps to this exact HTTP operation. |
| clear_conversation_group_route | DELETE | /v1/convai/realtime/conversations/{conversation_id}/conversation-group | planned | 8 | realtime | — | missing | — | No existing tool maps to this exact HTTP operation. |
| compile_procedures_route | POST | /v1/convai/agents/{agent_id}/branches/{branch_id}/procedures/compile | planned | 7 | agents | — | missing | — | No existing tool maps to this exact HTTP operation. |
| compose_detailed | POST | /v1/music/detailed | planned | 9 | music | — | missing | — | No existing tool maps to this exact HTTP operation. |
| compose_detailed_stream | POST | /v1/music/detailed/stream | planned | 9 | music | — | missing | — | No existing tool maps to this exact HTTP operation. |
| compose_plan | POST | /v1/music/plan | planned | 9 | music | — | partial | @mindstone/mcp-server-elevenlabs:create_music_plan | Maps prompt and duration_seconds to music_length_ms and fixes model_id to music_v1; source_composition_plan and enable_logging are absent. |
| convert_chapter_endpoint | POST | /v1/studio/projects/{project_id}/chapters/{chapter_id}/convert | planned | 10 | studio | — | missing | — | No existing tool maps to this exact HTTP operation. |
| convert_project_endpoint | POST | /v1/studio/projects/{project_id}/convert | planned | 10 | studio | — | missing | — | No existing tool maps to this exact HTTP operation. |
| copy_analysis_item_route | POST | /v1/convai/analysis-items/{analysis_item_id}/copy | planned | 7 | analysis-items | — | missing | — | No existing tool maps to this exact HTTP operation. |
| create_agent_conversation_ticket_route | POST | /v1/convai/triage-tickets | planned | 7 | triage-tickets | — | missing | — | No existing tool maps to this exact HTTP operation. |
| create_agent_deployment_route | POST | /v1/convai/agents/{agent_id}/deployments | planned | 7 | agents | — | missing | — | No existing tool maps to this exact HTTP operation. |
| create_agent_draft_route | POST | /v1/convai/agents/{agent_id}/drafts | planned | 7 | agents | — | missing | — | No existing tool maps to this exact HTTP operation. |
| create_agent_response_test_route | POST | /v1/convai/agent-testing/create | admitted | 1 | agent-testing | create | missing | — | No existing tool maps to this exact HTTP operation. |
| create_agent_route | POST | /v1/convai/agents/create | admitted | 1 | agents | create | partial | @mindstone/mcp-server-elevenlabs-agents:create_agent | Existing first-class model and knowledge-base fields map to llm_model and knowledge_base_document_ids instead of provider llm and structured knowledge_base locators. Advanced config is partial reach, not verified working equivalence; version and branch controls are absent. |
| create_agent_test_folder_route | POST | /v1/convai/agent-testing/folders | planned | 7 | agent-testing | — | missing | — | No existing tool maps to this exact HTTP operation. |
| create_analysis_item_route | POST | /v1/convai/analysis-items | planned | 7 | analysis-items | — | missing | — | No existing tool maps to this exact HTTP operation. |
| create_audio_native_project | POST | /v1/audio-native | planned | 10 | audio-native | — | missing | — | No existing tool maps to this exact HTTP operation. |
| create_auth_connection | POST | /v1/workspace/auth-connections | planned | 10 | workspace/auth-connections | — | missing | — | No existing tool maps to this exact HTTP operation. |
| create_batch_call | POST | /v1/convai/batch-calling/submit | planned | 8 | batch-calling | — | partial | @mindstone/mcp-server-elevenlabs-agents:submit_batch_call | Supports selected batch name, agent, phone, recipient and scheduling fields; other current batch controls are absent. |
| create_branch_route | POST | /v1/convai/agents/{agent_id}/branches | planned | 7 | agents | — | missing | — | No existing tool maps to this exact HTTP operation. |
| create_clip | POST | /v1/dubbing/resource/{dubbing_id}/speaker/{speaker_id}/segment | planned | 9 | dubbing | — | missing | — | No existing tool maps to this exact HTTP operation. |
| create_conversation_group_route | POST | /v1/convai/realtime/conversation-groups | planned | 8 | realtime | — | missing | — | No existing tool maps to this exact HTTP operation. |
| create_conversation_tag_route | POST | /v1/convai/tags | planned | 7 | tags | — | missing | — | No existing tool maps to this exact HTTP operation. |
| create_crawl_job_route | POST | /v1/convai/knowledge-base/crawl | planned | 7 | knowledge-base | — | missing | — | No existing tool maps to this exact HTTP operation. |
| create_dubbing | POST | /v1/dubbing | planned | 9 | dubbing | — | partial | @mindstone/mcp-server-elevenlabs:create_dubbing | Supports multipart file or source_url, target_lang, name, source_lang, num_speakers and watermark; other provider controls are absent. |
| create_environment | POST | /v1/convai/environments | planned | 7 | environments | — | missing | — | No existing tool maps to this exact HTTP operation. |
| create_environment_variable | POST | /v1/convai/environment-variables | planned | 7 | environment-variables | — | missing | — | No existing tool maps to this exact HTTP operation. |
| create_file_document_route | POST | /v1/convai/knowledge-base/file | admitted | 1 | knowledge-base | create | partial | @mindstone/mcp-server-elevenlabs-agents:add_knowledge_base_document | Supports multipart file, optional name and parent_folder_id, the complete current upload input. Agent attachment is separate; the existing authoring tool has known structured-locator mapping limitations. |
| create_finetune | POST | /v1/music/finetunes | planned | 9 | music | — | missing | — | No existing tool maps to this exact HTTP operation. |
| create_folder_route | POST | /v1/convai/knowledge-base/folder | admitted | 1 | knowledge-base | create | missing | — | No existing tool maps to this exact HTTP operation. |
| create_image_generation | POST | /v1/flows/image | planned | 10 | flows | — | missing | — | No existing tool maps to this exact HTTP operation. |
| create_manual_agent_ticket_route | POST | /v1/convai/agents/{agent_id}/triage-tickets | planned | 7 | agents | — | missing | — | No existing tool maps to this exact HTTP operation. |
| create_mcp_server_route | POST | /v1/convai/mcp-servers | planned | 7 | mcp-servers | — | missing | — | No existing tool maps to this exact HTTP operation. |
| create_merge_proposal_route | POST | /v1/convai/agents/{agent_id}/merge-proposals | planned | 7 | agents | — | missing | — | No existing tool maps to this exact HTTP operation. |
| create_or_update_user_voice_collection | POST | /v1/voices/collections | planned | 9 | voices | — | missing | — | No existing tool maps to this exact HTTP operation. |
| create_phone_number_route | POST | /v1/convai/phone-numbers | planned | 8 | phone-numbers | — | partial | @mindstone/mcp-server-elevenlabs-agents:import_phone_number | Imports selected provider phone-number fields; not every current provider variant is exposed. |
| create_podcast | POST | /v1/studio/podcasts | planned | 10 | studio | — | missing | — | No existing tool maps to this exact HTTP operation. |
| create_procedure_route | POST | /v1/convai/agents/{agent_id}/branches/{branch_id}/procedures | planned | 7 | agents | — | missing | — | No existing tool maps to this exact HTTP operation. |
| create_public_template_run | POST | /v1/flows/templates/{template_id}/runs | planned | 10 | flows | — | missing | — | No existing tool maps to this exact HTTP operation. |
| create_pvc_voice | POST | /v1/voices/pvc | planned | 9 | voices | — | missing | — | No existing tool maps to this exact HTTP operation. |
| create_realtime_session | POST | /v1/convai/realtime/client_secrets | planned | 8 | realtime | — | missing | — | No existing tool maps to this exact HTTP operation. |
| create_secret_route | POST | /v1/convai/secrets | planned | 7 | secrets | — | missing | — | No existing tool maps to this exact HTTP operation. |
| create_service_account | POST | /v1/service-accounts | excluded | — | account_and_keys | — | not-worth-exposing | — | Credential administration belongs in the provider dashboard. |
| create_service_account_api_key | POST | /v1/service-accounts/{service_account_user_id}/api-keys | excluded | — | account_and_keys | — | not-worth-exposing | — | Credential administration belongs in the provider dashboard. |
| create_speaker | POST | /v1/dubbing/resource/{dubbing_id}/speaker | planned | 9 | dubbing | — | missing | — | No existing tool maps to this exact HTTP operation. |
| create_speech_engine | POST | /v1/speech-engine | planned | 10 | speech-engine | — | missing | — | No existing tool maps to this exact HTTP operation. |
| create_text_document_route | POST | /v1/convai/knowledge-base/text | admitted | 1 | knowledge-base | create | partial | @mindstone/mcp-server-elevenlabs-agents:add_knowledge_base_document | Supports text, optional name and parent_folder_id, the complete current document-creation input. Agent attachment is separate; the existing authoring tool has known structured-locator mapping limitations. |
| create_text_to_speech_generation | POST | /v1/flows/text-to-speech | planned | 10 | flows | — | missing | — | No existing tool maps to this exact HTTP operation. |
| create_url_document_route | POST | /v1/convai/knowledge-base/url | admitted | 1 | knowledge-base | create | partial | @mindstone/mcp-server-elevenlabs-agents:add_knowledge_base_document | Supports url, optional name, parent_folder_id, enable_auto_sync and auto_remove; minimum_frequency_days is absent. Agent attachment is separate with known structured-locator mapping limitations. |
| create_video_generation | POST | /v1/flows/video | planned | 10 | flows | — | missing | — | No existing tool maps to this exact HTTP operation. |
| create_voice | POST | /v1/text-to-voice | planned | 9 | text-to-voice | — | partial | @mindstone/mcp-server-elevenlabs:create_voice_from_preview | Supports generated_voice_id, voice_name and voice_description; labels and played_not_selected_voice_ids are absent. |
| create_workspace_webhook_route | POST | /v1/workspace/webhooks | planned | 10 | workspace/webhooks | — | missing | — | No existing tool maps to this exact HTTP operation. |
| delete_agent_conversation_ticket_route | DELETE | /v1/convai/triage-tickets/{agentqa_ticket_id} | planned | 7 | triage-tickets | — | missing | — | No existing tool maps to this exact HTTP operation. |
| delete_agent_draft_route | DELETE | /v1/convai/agents/{agent_id}/drafts | planned | 7 | agents | — | missing | — | No existing tool maps to this exact HTTP operation. |
| delete_agent_hold_audio_route | DELETE | /v1/convai/agents/{agent_id}/hold-audio | planned | 7 | agents | — | missing | — | No existing tool maps to this exact HTTP operation. |
| delete_agent_route | DELETE | /v1/convai/agents/{agent_id} | admitted | 1 | agents | delete | partial | @mindstone/mcp-server-elevenlabs-agents:delete_agent | Supports agent_id; provider force query control is absent. |
| delete_agent_test_folder_route | DELETE | /v1/convai/agent-testing/folders/{folder_id} | planned | 7 | agent-testing | — | missing | — | No existing tool maps to this exact HTTP operation. |
| delete_analysis_item_route | DELETE | /v1/convai/analysis-items/{analysis_item_id} | planned | 7 | analysis-items | — | missing | — | No existing tool maps to this exact HTTP operation. |
| delete_asset_endpoint | DELETE | /v1/assets/{asset_id} | planned | 10 | assets | — | missing | — | No existing tool maps to this exact HTTP operation. |
| delete_audio_isolation_history_item | DELETE | /v1/audio-isolation/history/{history_item_id} | planned | 9 | audio-isolation | — | missing | — | No existing tool maps to this exact HTTP operation. |
| delete_auth_connection | DELETE | /v1/workspace/auth-connections/{auth_connection_id} | planned | 10 | workspace/auth-connections | — | missing | — | No existing tool maps to this exact HTTP operation. |
| delete_batch_call | DELETE | /v1/convai/batch-calling/{batch_id} | planned | 8 | batch-calling | — | missing | — | No existing tool maps to this exact HTTP operation. |
| delete_chapter_endpoint | DELETE | /v1/studio/projects/{project_id}/chapters/{chapter_id} | planned | 10 | studio | — | missing | — | No existing tool maps to this exact HTTP operation. |
| delete_chat_response_test_route | DELETE | /v1/convai/agent-testing/{test_id} | admitted | 1 | agent-testing | delete | missing | — | No existing tool maps to this exact HTTP operation. |
| delete_conversation_group_route | DELETE | /v1/convai/realtime/conversation-groups/{conversation_group_id} | planned | 8 | realtime | — | missing | — | No existing tool maps to this exact HTTP operation. |
| delete_conversation_route | DELETE | /v1/convai/conversations/{conversation_id} | planned | 7 | conversations | — | missing | — | No existing tool maps to this exact HTTP operation. |
| delete_conversation_tag_route | DELETE | /v1/convai/tags/{tag_id} | planned | 7 | tags | — | missing | — | No existing tool maps to this exact HTTP operation. |
| delete_dubbing | DELETE | /v1/dubbing/{dubbing_id} | planned | 9 | dubbing | — | covered | @mindstone/mcp-server-elevenlabs:delete_dubbing | Deletes by dubbing_id on the exact endpoint. |
| delete_environment | DELETE | /v1/convai/environments/{environment} | planned | 7 | environments | — | missing | — | No existing tool maps to this exact HTTP operation. |
| delete_environment_variable | DELETE | /v1/convai/environment-variables/{env_var_id} | planned | 7 | environment-variables | — | missing | — | No existing tool maps to this exact HTTP operation. |
| delete_finetune | DELETE | /v1/music/finetunes/{finetune_id} | planned | 9 | music | — | missing | — | No existing tool maps to this exact HTTP operation. |
| delete_invite | DELETE | /v1/workspace/invites | excluded | — | identity_and_seats | — | not-worth-exposing | — | Identity, membership and seat administration belongs in the provider dashboard. |
| delete_knowledge_base_document | DELETE | /v1/convai/knowledge-base/{documentation_id} | admitted | 1 | knowledge-base | delete | covered | @mindstone/mcp-server-elevenlabs-agents:delete_knowledge_base_document | Supports documentation_id and force; unwraps and sanitizes document responses. |
| delete_mcp_server_route | DELETE | /v1/convai/mcp-servers/{mcp_server_id} | planned | 7 | mcp-servers | — | missing | — | No existing tool maps to this exact HTTP operation. |
| delete_phone_number_route | DELETE | /v1/convai/phone-numbers/{phone_number_id} | planned | 8 | phone-numbers | — | covered | @mindstone/mcp-server-elevenlabs-agents:delete_phone_number | Deletes phone_number_id on the exact endpoint; there are no other current request controls. |
| delete_procedure_draft_route | DELETE | /v1/convai/agents/{agent_id}/branches/{branch_id}/procedures/{procedure_id}/draft | planned | 7 | agents | — | missing | — | No existing tool maps to this exact HTTP operation. |
| delete_project | DELETE | /v1/studio/projects/{project_id} | planned | 10 | studio | — | missing | — | No existing tool maps to this exact HTTP operation. |
| delete_pvc_voice_sample | DELETE | /v1/voices/pvc/{voice_id}/samples/{sample_id} | planned | 9 | voices | — | missing | — | No existing tool maps to this exact HTTP operation. |
| delete_rag_index | DELETE | /v1/convai/knowledge-base/{documentation_id}/rag-index/{rag_index_id} | planned | 7 | knowledge-base | — | missing | — | No existing tool maps to this exact HTTP operation. |
| delete_sample | DELETE | /v1/voices/{voice_id}/samples/{sample_id} | planned | 9 | voices | — | missing | — | No existing tool maps to this exact HTTP operation. |
| delete_secret_route | DELETE | /v1/convai/secrets/{secret_id} | planned | 7 | secrets | — | missing | — | No existing tool maps to this exact HTTP operation. |
| delete_segment | DELETE | /v1/dubbing/resource/{dubbing_id}/segment/{segment_id} | planned | 9 | dubbing | — | missing | — | No existing tool maps to this exact HTTP operation. |
| delete_service_account_api_key | DELETE | /v1/service-accounts/{service_account_user_id}/api-keys/{api_key_id} | excluded | — | account_and_keys | — | not-worth-exposing | — | Credential administration belongs in the provider dashboard. |
| delete_speech_engine | DELETE | /v1/speech-engine/{speech_engine_id} | planned | 10 | speech-engine | — | missing | — | No existing tool maps to this exact HTTP operation. |
| delete_speech_history_item | DELETE | /v1/history/{history_item_id} | planned | 9 | history | — | missing | — | No existing tool maps to this exact HTTP operation. |
| delete_tool_route | DELETE | /v1/convai/tools/{tool_id} | admitted | 1 | tools | delete | missing | — | No existing tool maps to this exact HTTP operation. |
| delete_transcript_by_id | DELETE | /v1/speech-to-text/transcripts/{transcription_id} | planned | 9 | speech-to-text | — | missing | — | No existing tool maps to this exact HTTP operation. |
| delete_user_voice_collection | DELETE | /v1/voices/collections/{collection_id} | planned | 9 | voices | — | missing | — | No existing tool maps to this exact HTTP operation. |
| delete_voice | DELETE | /v1/voices/{voice_id} | planned | 9 | voices | — | covered | @mindstone/mcp-server-elevenlabs:delete_voice | Deletes by path voice_id on the exact endpoint. |
| delete_whatsapp_account | DELETE | /v1/convai/whatsapp-accounts/{phone_number_id} | planned | 8 | whatsapp-accounts | — | missing | — | No existing tool maps to this exact HTTP operation. |
| delete_workspace_webhook_route | DELETE | /v1/workspace/webhooks/{webhook_id} | planned | 10 | workspace/webhooks | — | missing | — | No existing tool maps to this exact HTTP operation. |
| disable | POST | /v1/workspaces/api-keys/disable | excluded | — | account_and_keys | — | not-worth-exposing | — | Credential administration belongs in the provider dashboard. |
| disable_service_account_api_key | POST | /v1/service-accounts/{service_account_user_id}/api-keys/{api_key_id}/disable | excluded | — | account_and_keys | — | not-worth-exposing | — | Credential administration belongs in the provider dashboard. |
| download_speech_history_items | POST | /v1/history/download | planned | 9 | history | — | missing | — | No existing tool maps to this exact HTTP operation. |
| dub | POST | /v1/dubbing/resource/{dubbing_id}/dub | planned | 9 | dubbing | — | missing | — | No existing tool maps to this exact HTTP operation. |
| dubbing_language_create | POST | /v1/dubbing/project/{project_id}/language | planned | 9 | dubbing | — | missing | — | No existing tool maps to this exact HTTP operation. |
| dubbing_language_delete | DELETE | /v1/dubbing/project/{project_id}/language/{language_id} | planned | 9 | dubbing | — | missing | — | No existing tool maps to this exact HTTP operation. |
| dubbing_language_get | GET | /v1/dubbing/project/{project_id}/language/{language_id} | planned | 9 | dubbing | — | missing | — | No existing tool maps to this exact HTTP operation. |
| dubbing_language_list | GET | /v1/dubbing/project/{project_id}/language | planned | 9 | dubbing | — | missing | — | No existing tool maps to this exact HTTP operation. |
| dubbing_project_create | POST | /v1/dubbing/project | planned | 9 | dubbing | — | missing | — | No existing tool maps to this exact HTTP operation. |
| dubbing_project_delete | DELETE | /v1/dubbing/project/{project_id} | planned | 9 | dubbing | — | missing | — | No existing tool maps to this exact HTTP operation. |
| dubbing_project_get | GET | /v1/dubbing/project/{project_id} | planned | 9 | dubbing | — | missing | — | No existing tool maps to this exact HTTP operation. |
| dubbing_project_list | GET | /v1/dubbing/project | planned | 9 | dubbing | — | missing | — | No existing tool maps to this exact HTTP operation. |
| dubbing_target_transcript_get | GET | /v1/dubbing/project/{project_id}/language/{language_id}/transcript | planned | 9 | dubbing | — | missing | — | No existing tool maps to this exact HTTP operation. |
| dubbing_target_transcript_regenerate | POST | /v1/dubbing/project/{project_id}/language/{language_id}/transcript/regenerate | planned | 9 | dubbing | — | missing | — | No existing tool maps to this exact HTTP operation. |
| dubbing_target_transcript_segment_update | PATCH | /v1/dubbing/project/{project_id}/language/{language_id}/transcript/segment/{segment_id} | planned | 9 | dubbing | — | missing | — | No existing tool maps to this exact HTTP operation. |
| dubbing_target_transcript_segments_update | PATCH | /v1/dubbing/project/{project_id}/language/{language_id}/transcript/segments | planned | 9 | dubbing | — | missing | — | No existing tool maps to this exact HTTP operation. |
| dubbing_transcript_get | GET | /v1/dubbing/project/{project_id}/transcript | planned | 9 | dubbing | — | missing | — | No existing tool maps to this exact HTTP operation. |
| dubbing_transcript_segment_add | POST | /v1/dubbing/project/{project_id}/transcript/segment | planned | 9 | dubbing | — | missing | — | No existing tool maps to this exact HTTP operation. |
| dubbing_transcript_segment_delete | DELETE | /v1/dubbing/project/{project_id}/transcript/segment/{segment_id} | planned | 9 | dubbing | — | missing | — | No existing tool maps to this exact HTTP operation. |
| dubbing_transcript_segment_update | PATCH | /v1/dubbing/project/{project_id}/transcript/segment/{segment_id} | planned | 9 | dubbing | — | missing | — | No existing tool maps to this exact HTTP operation. |
| dubbing_transcript_segments_update | PATCH | /v1/dubbing/project/{project_id}/transcript/segments | planned | 9 | dubbing | — | missing | — | No existing tool maps to this exact HTTP operation. |
| duplicate_agent_route | POST | /v1/convai/agents/{agent_id}/duplicate | admitted | 1 | agents | create | covered | @mindstone/mcp-server-elevenlabs-agents:duplicate_agent | Supports agent_id and optional name, the complete current operation input; may perform a follow-up read to resolve the agent response. |
| duplicate_speech_engine | POST | /v1/speech-engine/{speech_engine_id}/duplicate | planned | 10 | speech-engine | — | missing | — | No existing tool maps to this exact HTTP operation. |
| edit_chapter | POST | /v1/studio/projects/{project_id}/chapters/{chapter_id} | planned | 10 | studio | — | missing | — | No existing tool maps to this exact HTTP operation. |
| edit_project | POST | /v1/studio/projects/{project_id} | planned | 10 | studio | — | missing | — | No existing tool maps to this exact HTTP operation. |
| edit_project_content | POST | /v1/studio/projects/{project_id}/content | planned | 10 | studio | — | missing | — | No existing tool maps to this exact HTTP operation. |
| edit_pvc_voice | POST | /v1/voices/pvc/{voice_id} | planned | 9 | voices | — | missing | — | No existing tool maps to this exact HTTP operation. |
| edit_pvc_voice_sample | POST | /v1/voices/pvc/{voice_id}/samples/{sample_id} | planned | 9 | voices | — | missing | — | No existing tool maps to this exact HTTP operation. |
| edit_service_account_api_key | PATCH | /v1/service-accounts/{service_account_user_id}/api-keys/{api_key_id} | excluded | — | account_and_keys | — | not-worth-exposing | — | Credential administration belongs in the provider dashboard. |
| edit_voice | POST | /v1/voices/{voice_id}/edit | planned | 9 | voices | — | missing | — | No existing tool maps to this exact HTTP operation. |
| edit_voice_settings | POST | /v1/voices/{voice_id}/settings/edit | planned | 9 | voices | — | missing | — | No existing tool maps to this exact HTTP operation. |
| edit_workspace_webhook_route | PATCH | /v1/workspace/webhooks/{webhook_id} | planned | 10 | workspace/webhooks | — | missing | — | No existing tool maps to this exact HTTP operation. |
| export_batch_call | GET | /v1/convai/batch-calling/{batch_id}/export | planned | 8 | batch-calling | — | missing | — | No existing tool maps to this exact HTTP operation. |
| forced_alignment | POST | /v1/forced-alignment | planned | 9 | forced-alignment | — | covered | @mindstone/mcp-server-elevenlabs:forced_alignment | Uploads multipart file and text to the exact endpoint; no other operation-specific parameters. |
| generate | POST | /v1/music | planned | 9 | music | — | partial | @mindstone/mcp-server-elevenlabs:generate_music, @mindstone/mcp-server-elevenlabs:generate_music_from_plan | Maps prompt and duration_seconds or composition_plan, plus seed and output_format; fixes model_id to music_v1 and omits current generation_mode, finetune and other music controls. |
| get_agent_conversation_ticket_route | GET | /v1/convai/triage-tickets/{agentqa_ticket_id} | planned | 7 | triage-tickets | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_agent_knowledge_base_size | GET | /v1/convai/agent/{agent_id}/knowledge-base/size | planned | 7 | agent | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_agent_knowledge_base_summaries_route | GET | /v1/convai/knowledge-base/summaries | planned | 7 | knowledge-base | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_agent_link_route | GET | /v1/convai/agents/{agent_id}/link | planned | 7 | agents | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_agent_llm_expected_cost_calculation | POST | /v1/convai/agent/{agent_id}/llm-usage/calculate | planned | 7 | agent | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_agent_response_test_route | GET | /v1/convai/agent-testing/{test_id} | admitted | 1 | agent-testing | read | missing | — | No existing tool maps to this exact HTTP operation. |
| get_agent_response_tests_summaries_route | POST | /v1/convai/agent-testing/summaries | planned | 7 | agent-testing | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_agent_route | GET | /v1/convai/agents/{agent_id} | admitted | 1 | agents | read | partial | @mindstone/mcp-server-elevenlabs-agents:get_agent | Reads agent_id; version_id, branch_id and procedure-workflow controls are not exposed. |
| get_agent_summaries_route | GET | /v1/convai/agents/summaries | planned | 7 | agents | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_agent_test_folder_route | GET | /v1/convai/agent-testing/folders/{folder_id} | planned | 7 | agent-testing | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_agent_topics_route | GET | /v1/convai/agents/{agent_id}/topics | planned | 7 | agents | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_agent_widget_route | GET | /v1/convai/agents/{agent_id}/widget | planned | 7 | agents | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_agents_route | GET | /v1/convai/agents | admitted | 1 | agents | read | partial | @mindstone/mcp-server-elevenlabs-agents:list_agents | Supports cursor and page_size; search, ownership, archive, tag and sorting filters are absent. |
| get_analysis_item_dependent_agents_route | GET | /v1/convai/analysis-items/{analysis_item_id}/dependent-agents | planned | 7 | analysis-items | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_analysis_item_route | GET | /v1/convai/analysis-items/{analysis_item_id} | planned | 7 | analysis-items | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_asset | GET | /v1/assets/{asset_id} | planned | 10 | assets | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_assignable_users_route | GET | /v1/convai/agents/{agent_id}/triage-tickets/assignable-users | planned | 7 | agents | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_audio_effects_catalog | GET | /v1/audio-effects/catalog | planned | 9 | audio-effects | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_audio_from_sample | GET | /v1/voices/{voice_id}/samples/{sample_id}/audio | planned | 9 | voices | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_audio_full_from_speech_history_item | GET | /v1/history/{history_item_id}/audio | planned | 9 | history | — | covered | @mindstone/mcp-server-elevenlabs:get_history_item_audio | Downloads by history_item_id on the exact endpoint; there are no operation-specific query options. |
| get_audio_isolation_history | GET | /v1/audio-isolation/history | planned | 9 | audio-isolation | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_audio_native_project_settings_endpoint | GET | /v1/audio-native/{project_id}/settings | planned | 10 | audio-native | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_batch_call | GET | /v1/convai/batch-calling/{batch_id} | planned | 8 | batch-calling | — | partial | @mindstone/mcp-server-elevenlabs-agents:get_batch_call | Reads batch_id on the exact endpoint. |
| get_branch_route | GET | /v1/convai/agents/{agent_id}/branches/{branch_id} | planned | 7 | agents | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_branches_route | GET | /v1/convai/agents/{agent_id}/branches | planned | 7 | agents | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_chapter_by_id_endpoint | GET | /v1/studio/projects/{project_id}/chapters/{chapter_id} | planned | 10 | studio | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_chapter_snapshot_endpoint | GET | /v1/studio/projects/{project_id}/chapters/{chapter_id}/snapshots/{chapter_snapshot_id} | planned | 10 | studio | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_chapter_snapshots | GET | /v1/studio/projects/{project_id}/chapters/{chapter_id}/snapshots | planned | 10 | studio | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_chapters | GET | /v1/studio/projects/{project_id}/chapters | planned | 10 | studio | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_conversation_audio_route | GET | /v1/convai/conversations/{conversation_id}/audio | planned | 7 | conversations | — | covered | @mindstone/mcp-server-elevenlabs-agents:get_conversation_audio | Downloads by conversation_id on the exact endpoint. |
| get_conversation_group_route | GET | /v1/convai/realtime/conversation-groups/{conversation_group_id} | planned | 8 | realtime | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_conversation_histories_route | GET | /v1/convai/conversations | planned | 7 | conversations | — | partial | @mindstone/mcp-server-elevenlabs-agents:list_conversations | Supports cursor, page_size and agent_id. Legacy start_date/end_date query names and boolean call_successful do not match the pinned time-filter and success-enum shapes; other current filters are absent. |
| get_conversation_history_route | GET | /v1/convai/conversations/{conversation_id} | planned | 7 | conversations | — | partial | @mindstone/mcp-server-elevenlabs-agents:get_conversation | Reads conversation_id on the exact endpoint; the provider format query option is absent. |
| get_conversation_signed_link | GET | /v1/convai/conversation/get-signed-url | planned | 8 | conversation | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_conversation_sip_messages | GET | /v1/convai/conversations/{conversation_id}/sip-messages | planned | 7 | conversations | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_conversation_summary_route | GET | /v1/convai/conversations/{conversation_id}/summary | planned | 7 | conversations | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_conversation_tag_route | GET | /v1/convai/tags/{tag_id} | planned | 7 | tags | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_conversation_users_route | GET | /v1/convai/users | planned | 7 | users | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_crawl_job_route | GET | /v1/convai/knowledge-base/crawl/{crawl_job_id} | planned | 7 | knowledge-base | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_dashboard_settings_route | GET | /v1/convai/settings/dashboard | planned | 7 | settings | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_documentation_chunk_from_knowledge_base | GET | /v1/convai/knowledge-base/{documentation_id}/chunk/{chunk_id} | planned | 7 | knowledge-base | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_documentation_chunks_from_knowledge_base | GET | /v1/convai/knowledge-base/{documentation_id}/chunks | admitted | 1 | knowledge-base | read | missing | — | No existing tool maps to this exact HTTP operation. |
| get_documentation_from_knowledge_base | GET | /v1/convai/knowledge-base/{documentation_id} | admitted | 1 | knowledge-base | read | partial | @mindstone/mcp-server-elevenlabs-agents:get_knowledge_base_doc | Reads documentation_id and optionally fetches content; omits provider agent_id query. |
| get_dubbed_file | GET | /v1/dubbing/{dubbing_id}/audio/{language_code} | planned | 9 | dubbing | — | covered | @mindstone/mcp-server-elevenlabs:download_dubbed_audio | Downloads by dubbing_id and language_code on the exact endpoint. |
| get_dubbed_metadata | GET | /v1/dubbing/{dubbing_id} | planned | 9 | dubbing | — | covered | @mindstone/mcp-server-elevenlabs:get_dubbing | Reads dubbing_id on the exact metadata endpoint; response is projected to selected fields. |
| get_dubbed_transcript_file | GET | /v1/dubbing/{dubbing_id}/transcript/{language_code} | planned | 9 | dubbing | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_dubbing_resource | GET | /v1/dubbing/resource/{dubbing_id} | planned | 9 | dubbing | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_dubbing_transcripts | GET | /v1/dubbing/{dubbing_id}/transcripts/{language_code}/format/{format_type} | planned | 9 | dubbing | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_environment_variable | GET | /v1/convai/environment-variables/{env_var_id} | planned | 7 | environment-variables | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_finetune | GET | /v1/music/finetunes/{finetune_id} | planned | 9 | music | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_finetunes | GET | /v1/music/finetunes | planned | 9 | music | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_groups_endpoint | GET | /v1/workspace/groups | excluded | — | identity_and_seats | — | not-worth-exposing | — | Identity, membership and seat administration belongs in the provider dashboard. |
| get_image_generation | GET | /v1/flows/image/{generation_id} | planned | 10 | flows | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_knowledge_base_bulk_dependent_agents_route | POST | /v1/convai/knowledge-base/dependent-agents | planned | 7 | knowledge-base | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_knowledge_base_content | GET | /v1/convai/knowledge-base/{documentation_id}/content | admitted | 1 | knowledge-base | read | partial | @mindstone/mcp-server-elevenlabs-agents:get_knowledge_base_doc | Optional content fetch by documentation_id; failures are suppressed into metadata-only results rather than exposed as an independent content operation. |
| get_knowledge_base_dependent_agents | GET | /v1/convai/knowledge-base/{documentation_id}/dependent-agents | admitted | 1 | knowledge-base | read | missing | — | No existing tool maps to this exact HTTP operation. |
| get_knowledge_base_list_route | GET | /v1/convai/knowledge-base | admitted | 1 | knowledge-base | read | partial | @mindstone/mcp-server-elevenlabs-agents:list_knowledge_base_docs | Supports cursor and page_size; search, document type, folder, ownership and sorting filters are absent. |
| get_knowledge_base_source_file_url | GET | /v1/convai/knowledge-base/{documentation_id}/source-file-url | planned | 7 | knowledge-base | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_library_voices | GET | /v1/shared-voices | planned | 9 | shared-voices | — | partial | @mindstone/mcp-server-elevenlabs:search_shared_voices | Supports search, category, gender, age, accent, language and page_size; other provider filters and variants are absent. |
| get_live_count | GET | /v1/convai/analytics/live-count | planned | 7 | analytics | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_livekit_token | GET | /v1/convai/conversation/token | planned | 8 | conversation | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_mcp_route | GET | /v1/convai/mcp-servers/{mcp_server_id} | planned | 7 | mcp-servers | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_mcp_tool_config_override_route | GET | /v1/convai/mcp-servers/{mcp_server_id}/tool-configs/{tool_name} | planned | 7 | mcp-servers | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_merge_proposal_route | GET | /v1/convai/agents/{agent_id}/merge-proposals/{merge_proposal_id} | planned | 7 | agents | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_models | GET | /v1/models | planned | 9 | models | — | covered | @mindstone/mcp-server-elevenlabs:list_models | Lists models from the exact endpoint; no operation-specific request parameters. |
| get_or_create_rag_indexes | POST | /v1/convai/knowledge-base/rag-index | planned | 7 | knowledge-base | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_phone_number_route | GET | /v1/convai/phone-numbers/{phone_number_id} | planned | 8 | phone-numbers | — | covered | @mindstone/mcp-server-elevenlabs-agents:get_phone_number | Reads phone_number_id on the exact endpoint; there are no other current request controls. |
| get_procedure_draft_route | GET | /v1/convai/agents/{agent_id}/branches/{branch_id}/procedures/{procedure_id}/draft | planned | 7 | agents | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_procedure_route | GET | /v1/convai/agents/{agent_id}/branches/{branch_id}/procedures/{procedure_id} | planned | 7 | agents | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_project_by_id | GET | /v1/studio/projects/{project_id} | planned | 10 | studio | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_project_muted_tracks_endpoint | GET | /v1/studio/projects/{project_id}/muted-tracks | planned | 10 | studio | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_project_snapshot_endpoint | GET | /v1/studio/projects/{project_id}/snapshots/{project_snapshot_id} | planned | 10 | studio | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_project_snapshots | GET | /v1/studio/projects/{project_id}/snapshots | planned | 10 | studio | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_projects | GET | /v1/studio/projects | planned | 10 | studio | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_pronunciation_dictionaries_metadata | GET | /v1/pronunciation-dictionaries | planned | 9 | pronunciation-dictionaries | — | partial | @mindstone/mcp-server-elevenlabs:list_pronunciation_dictionaries | Supports page_size, cursor and include_archived; sort and sort_direction are absent. |
| get_pronunciation_dictionary_metadata | GET | /v1/pronunciation-dictionaries/{pronunciation_dictionary_id} | planned | 9 | pronunciation-dictionaries | — | covered | @mindstone/mcp-server-elevenlabs:get_pronunciation_dictionary | Reads pronunciation_dictionary_id on the exact metadata endpoint. |
| get_pronunciation_dictionary_version_pls | GET | /v1/pronunciation-dictionaries/{dictionary_id}/{version_id}/download | planned | 9 | pronunciation-dictionaries | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_public_llm_expected_cost_calculation | POST | /v1/convai/llm-usage/calculate | planned | 7 | llm-usage | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_public_template | GET | /v1/flows/templates/{template_id} | planned | 10 | flows | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_public_template_run | GET | /v1/flows/templates/{template_id}/runs/{run_id} | planned | 10 | flows | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_pvc_sample_audio | GET | /v1/voices/pvc/{voice_id}/samples/{sample_id}/audio | planned | 9 | voices | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_pvc_sample_speakers | GET | /v1/voices/pvc/{voice_id}/samples/{sample_id}/speakers | planned | 9 | voices | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_pvc_sample_visual_waveform | GET | /v1/voices/pvc/{voice_id}/samples/{sample_id}/waveform | planned | 9 | voices | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_pvc_voice_captcha | GET | /v1/voices/pvc/{voice_id}/captcha | planned | 9 | voices | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_rag_index_overview | GET | /v1/convai/knowledge-base/rag-index | planned | 7 | knowledge-base | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_rag_indexes | GET | /v1/convai/knowledge-base/{documentation_id}/rag-index | admitted | 1 | knowledge-base | read | covered | @mindstone/mcp-server-elevenlabs-agents:get_knowledge_base_rag_index_status | Reads documentation_id on the exact RAG-index endpoint. |
| get_resource_metadata | GET | /v1/workspace/resources/{resource_id} | planned | 10 | workspace/resources | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_secret_dependencies_route | GET | /v1/convai/secrets/{secret_id}/dependencies/{resource_type} | planned | 7 | secrets | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_secret_route | GET | /v1/convai/secrets/{secret_id} | planned | 7 | secrets | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_secrets_route | GET | /v1/convai/secrets | planned | 7 | secrets | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_service_account_api_keys_route | GET | /v1/service-accounts/{service_account_user_id}/api-keys | excluded | — | account_and_keys | — | not-worth-exposing | — | Credential administration belongs in the provider dashboard. |
| get_settings_route | GET | /v1/convai/settings | planned | 7 | settings | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_signed_url_deprecated | GET | /v1/convai/conversation/get_signed_url | planned | 8 | conversation | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_similar_library_voices | POST | /v1/similar-voices | planned | 9 | similar-voices | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_similar_voices_for_speaker | GET | /v1/dubbing/resource/{dubbing_id}/speaker/{speaker_id}/similar-voices | planned | 9 | dubbing | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_single_use_token | POST | /v1/single-use-token/{token_type} | planned | 9 | single-use-token | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_speaker_audio | GET | /v1/voices/pvc/{voice_id}/samples/{sample_id}/speakers/{speaker_id}/audio | planned | 9 | voices | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_speech_engine | GET | /v1/speech-engine/{speech_engine_id} | planned | 10 | speech-engine | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_speech_history | GET | /v1/history | planned | 9 | history | — | partial | @mindstone/mcp-server-elevenlabs:list_history | Supports page_size, start_after_history_item_id, voice_id and search; omits current history filters. |
| get_speech_history_item_by_id | GET | /v1/history/{history_item_id} | planned | 9 | history | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_test_invocation_route | GET | /v1/convai/test-invocations/{test_invocation_id} | admitted | 1 | test-invocations | read | missing | — | No existing tool maps to this exact HTTP operation. |
| get_text_to_speech_generation | GET | /v1/flows/text-to-speech/{generation_id} | planned | 10 | flows | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_tool_dependent_agents_route | GET | /v1/convai/tools/{tool_id}/dependent-agents | admitted | 1 | tools | read | missing | — | No existing tool maps to this exact HTTP operation. |
| get_tool_executions_route | GET | /v1/convai/tools/{tool_id}/executions | planned | 7 | tools | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_tool_route | GET | /v1/convai/tools/{tool_id} | admitted | 1 | tools | read | missing | — | No existing tool maps to this exact HTTP operation. |
| get_tools_route | GET | /v1/convai/tools | admitted | 1 | tools | read | partial | @mindstone/mcp-server-elevenlabs-agents:list_agent_tools | Supports cursor, page_size and search; omits other current tool-list filters. |
| get_transcript_by_id | GET | /v1/speech-to-text/transcripts/{transcription_id} | planned | 9 | speech-to-text | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_user_info | GET | /v1/user | planned | 9 | user | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_user_subscription_info | GET | /v1/user/subscription | planned | 9 | user | — | covered | @mindstone/mcp-server-elevenlabs:check_subscription | Reads subscription information from the exact endpoint; no operation-specific request parameters. |
| get_user_voice_collection | GET | /v1/voices/collections/{collection_id} | planned | 9 | voices | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_user_voice_collections | GET | /v1/voices/collections | planned | 9 | voices | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_user_voices_v2 | GET | /v2/voices | planned | 9 | voices-v2 | — | partial | @mindstone/mcp-server-elevenlabs:list_voices | Supports search, category and page_size; does not expose next_page_token or other current list filters. |
| get_version_metadata_route | GET | /v1/convai/agents/{agent_id}/versions/{version_id} | planned | 7 | agents | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_video_generation | GET | /v1/flows/video/{generation_id} | planned | 10 | flows | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_voice_accents | GET | /v1/voices/accents | planned | 9 | voices | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_voice_by_id | GET | /v1/voices/{voice_id} | planned | 9 | voices | — | partial | @mindstone/mcp-server-elevenlabs:get_voice | Supports path voice_id; omits current query variants and returns selected metadata. |
| get_voice_settings | GET | /v1/voices/{voice_id}/settings | planned | 9 | voices | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_voice_settings_default | GET | /v1/voices/settings/default | planned | 9 | voices | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_voices | GET | /v1/voices | planned | 9 | voices | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_whatsapp_account | GET | /v1/convai/whatsapp-accounts/{phone_number_id} | planned | 8 | whatsapp-accounts | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_workspace_audit_logs | GET | /v1/workspace/audit-logs | planned | 10 | workspace/audit-logs | — | missing | — | No existing tool maps to this exact HTTP operation. |
| get_workspace_batch_calls | GET | /v1/convai/batch-calling/workspace | planned | 8 | batch-calling | — | covered | @mindstone/mcp-server-elevenlabs-agents:list_batch_calls | Supports limit, last_doc and agent_id, the complete current query parameters; normalizes pagination into next_cursor. |
| get_workspace_members | GET | /v1/workspace/members | excluded | — | identity_and_seats | — | not-worth-exposing | — | Identity, membership and seat administration belongs in the provider dashboard. |
| get_workspace_service_accounts | GET | /v1/service-accounts | excluded | — | account_and_keys | — | not-worth-exposing | — | Credential administration belongs in the provider dashboard. |
| get_workspace_webhooks_route | GET | /v1/workspace/webhooks | planned | 10 | workspace/webhooks | — | missing | — | No existing tool maps to this exact HTTP operation. |
| handle_exotel_outbound_call | POST | /v1/convai/exotel/outbound-call | planned | 8 | exotel | — | missing | — | No existing tool maps to this exact HTTP operation. |
| handle_sip_trunk_outbound_call | POST | /v1/convai/sip-trunk/outbound-call | planned | 8 | sip-trunk | — | partial | @mindstone/mcp-server-elevenlabs-agents:make_outbound_call | Supports agent_id, agent_phone_number_id, to_number and selected call overrides after phone-provider lookup; other current call options are absent. |
| handle_twilio_outbound_call | POST | /v1/convai/twilio/outbound-call | planned | 8 | twilio | — | partial | @mindstone/mcp-server-elevenlabs-agents:make_outbound_call | Supports agent_id, agent_phone_number_id, to_number and selected call overrides after phone-provider lookup; other current call options are absent. |
| invite_user | POST | /v1/workspace/invites/add | excluded | — | identity_and_seats | — | not-worth-exposing | — | Identity, membership and seat administration belongs in the provider dashboard. |
| invite_users_bulk | POST | /v1/workspace/invites/add-bulk | excluded | — | identity_and_seats | — | not-worth-exposing | — | Identity, membership and seat administration belongs in the provider dashboard. |
| list_agent_conversation_tickets_route | GET | /v1/convai/agents/{agent_id}/triage-tickets | planned | 7 | agents | — | missing | — | No existing tool maps to this exact HTTP operation. |
| list_agent_deployments_route | GET | /v1/convai/agents/{agent_id}/deployments | planned | 7 | agents | — | missing | — | No existing tool maps to this exact HTTP operation. |
| list_analysis_item_versions_route | GET | /v1/convai/analysis-items/{analysis_item_id}/versions | planned | 7 | analysis-items | — | missing | — | No existing tool maps to this exact HTTP operation. |
| list_analysis_items_route | GET | /v1/convai/analysis-items | planned | 7 | analysis-items | — | missing | — | No existing tool maps to this exact HTTP operation. |
| list_assets | GET | /v1/assets | planned | 10 | assets | — | missing | — | No existing tool maps to this exact HTTP operation. |
| list_auth_connections | GET | /v1/workspace/auth-connections | planned | 10 | workspace/auth-connections | — | missing | — | No existing tool maps to this exact HTTP operation. |
| list_available_llms | GET | /v1/convai/llm/list | admitted | 1 | llm | read | missing | — | No existing tool maps to this exact HTTP operation. |
| list_chat_response_tests_route | GET | /v1/convai/agent-testing | admitted | 1 | agent-testing | read | missing | — | No existing tool maps to this exact HTTP operation. |
| list_conversation_groups_route | GET | /v1/convai/realtime/conversation-groups | planned | 8 | realtime | — | missing | — | No existing tool maps to this exact HTTP operation. |
| list_conversation_tags_route | GET | /v1/convai/tags | planned | 7 | tags | — | missing | — | No existing tool maps to this exact HTTP operation. |
| list_crawl_jobs_route | GET | /v1/convai/knowledge-base/crawl | planned | 7 | knowledge-base | — | missing | — | No existing tool maps to this exact HTTP operation. |
| list_dubs | GET | /v1/dubbing | planned | 9 | dubbing | — | missing | — | No existing tool maps to this exact HTTP operation. |
| list_environment_variables | GET | /v1/convai/environment-variables | planned | 7 | environment-variables | — | missing | — | No existing tool maps to this exact HTTP operation. |
| list_environments | GET | /v1/convai/environments | planned | 7 | environments | — | missing | — | No existing tool maps to this exact HTTP operation. |
| list_image_generations | GET | /v1/flows/image | planned | 10 | flows | — | missing | — | No existing tool maps to this exact HTTP operation. |
| list_mcp_server_tools_route | GET | /v1/convai/mcp-servers/{mcp_server_id}/tools | planned | 7 | mcp-servers | — | missing | — | No existing tool maps to this exact HTTP operation. |
| list_mcp_servers_route | GET | /v1/convai/mcp-servers | planned | 7 | mcp-servers | — | missing | — | No existing tool maps to this exact HTTP operation. |
| list_merge_proposals_route | GET | /v1/convai/agents/{agent_id}/merge-proposals | planned | 7 | agents | — | missing | — | No existing tool maps to this exact HTTP operation. |
| list_phone_numbers_page_route | GET | /v1/convai/v2/phone-numbers | planned | 8 | v2/phone-numbers | — | missing | — | No existing tool maps to this exact HTTP operation. |
| list_phone_numbers_route | GET | /v1/convai/phone-numbers | planned | 8 | phone-numbers | — | partial | @mindstone/mcp-server-elevenlabs-agents:list_phone_numbers | Calls the exact list endpoint but sends cursor/page_size, which are not in the pinned provider query schema; provider, agent_id and branch_id filters are absent. |
| list_procedures_route | GET | /v1/convai/agents/{agent_id}/branches/{branch_id}/procedures | planned | 7 | agents | — | missing | — | No existing tool maps to this exact HTTP operation. |
| list_public_template_runs | GET | /v1/flows/templates/{template_id}/runs | planned | 10 | flows | — | missing | — | No existing tool maps to this exact HTTP operation. |
| list_public_templates | GET | /v1/flows/templates | planned | 10 | flows | — | missing | — | No existing tool maps to this exact HTTP operation. |
| list_sip_messages | GET | /v1/convai/phone-numbers/{phone_number_id}/sip-messages | planned | 8 | phone-numbers | — | missing | — | No existing tool maps to this exact HTTP operation. |
| list_speech_engines | GET | /v1/speech-engine | planned | 10 | speech-engine | — | missing | — | No existing tool maps to this exact HTTP operation. |
| list_test_invocations_route | GET | /v1/convai/test-invocations | admitted | 1 | test-invocations | read | missing | — | No existing tool maps to this exact HTTP operation. |
| list_text_to_speech_generations | GET | /v1/flows/text-to-speech | planned | 10 | flows | — | missing | — | No existing tool maps to this exact HTTP operation. |
| list_video_generations | GET | /v1/flows/video | planned | 10 | flows | — | missing | — | No existing tool maps to this exact HTTP operation. |
| list_whatsapp_accounts | GET | /v1/convai/whatsapp-accounts | planned | 8 | whatsapp-accounts | — | missing | — | No existing tool maps to this exact HTTP operation. |
| list_workspace_conversation_tickets_route | GET | /v1/convai/triage-tickets | planned | 7 | triage-tickets | — | missing | — | No existing tool maps to this exact HTTP operation. |
| merge_agent_conversation_tickets_route | POST | /v1/convai/triage-tickets/{agentqa_ticket_id}/merge | planned | 7 | triage-tickets | — | missing | — | No existing tool maps to this exact HTTP operation. |
| merge_branch_into_target | POST | /v1/convai/agents/{agent_id}/branches/{source_branch_id}/merge | planned | 7 | agents | — | missing | — | No existing tool maps to this exact HTTP operation. |
| merge_preview_route | GET | /v1/convai/agents/{agent_id}/branches/{source_branch_id}/merge-preview | planned | 7 | agents | — | missing | — | No existing tool maps to this exact HTTP operation. |
| migrate_segments | POST | /v1/dubbing/resource/{dubbing_id}/migrate-segments | planned | 9 | dubbing | — | missing | — | No existing tool maps to this exact HTTP operation. |
| patch_agent_settings_route | PATCH | /v1/convai/agents/{agent_id} | admitted | 1 | agents | change | partial | @mindstone/mcp-server-elevenlabs-agents:update_agent | Existing first-class model and knowledge-base fields map to llm_model and knowledge_base_document_ids instead of provider llm and structured knowledge_base locators. Advanced config is partial reach, not verified working equivalence; version and branch controls are absent. |
| patch_pronunciation_dictionary | PATCH | /v1/pronunciation-dictionaries/{pronunciation_dictionary_id} | planned | 9 | pronunciation-dictionaries | — | partial | @mindstone/mcp-server-elevenlabs:archive_pronunciation_dictionary | Only sends archived=true; does not support other dictionary edits or restoration. |
| post_agent_avatar_route | POST | /v1/convai/agents/{agent_id}/avatar | planned | 7 | agents | — | missing | — | No existing tool maps to this exact HTTP operation. |
| post_agent_hold_audio_route | POST | /v1/convai/agents/{agent_id}/hold-audio | planned | 7 | agents | — | missing | — | No existing tool maps to this exact HTTP operation. |
| post_conversation_feedback_route | POST | /v1/convai/conversations/{conversation_id}/feedback | planned | 7 | conversations | — | partial | @mindstone/mcp-server-elevenlabs-agents:submit_conversation_feedback | Supports conversation_id and requires non-null feedback ('like' or 'dislike'); the provider also permits omitted or null feedback. |
| post_knowledge_base_bulk_delete_route | POST | /v1/convai/knowledge-base/bulk-delete | planned | 7 | knowledge-base | — | missing | — | No existing tool maps to this exact HTTP operation. |
| post_knowledge_base_bulk_move_route | POST | /v1/convai/knowledge-base/bulk-move | planned | 7 | knowledge-base | — | missing | — | No existing tool maps to this exact HTTP operation. |
| post_knowledge_base_move_route | POST | /v1/convai/knowledge-base/{document_id}/move | planned | 7 | knowledge-base | — | missing | — | No existing tool maps to this exact HTTP operation. |
| public_create_order | POST | /v1/productions/orders | excluded | — | productions | — | not-worth-exposing | — | Production orders and charging belong in the provider dashboard. |
| public_get_available_languages | GET | /v1/productions/orders/languages/{order_item_kind} | excluded | — | productions | — | not-worth-exposing | — | Production orders and charging belong in the provider dashboard. |
| public_get_media_info | GET | /v1/productions/orders/{order_id}/media/{media_id} | excluded | — | productions | — | not-worth-exposing | — | Production orders and charging belong in the provider dashboard. |
| public_get_order | GET | /v1/productions/orders/{order_id} | excluded | — | productions | — | not-worth-exposing | — | Production orders and charging belong in the provider dashboard. |
| public_get_order_deliverables | GET | /v1/productions/orders/{order_id}/deliverables | excluded | — | productions | — | not-worth-exposing | — | Production orders and charging belong in the provider dashboard. |
| public_list_orders | GET | /v1/productions/orders | excluded | — | productions | — | not-worth-exposing | — | Production orders and charging belong in the provider dashboard. |
| public_register_media | POST | /v1/productions/orders/{order_id}/media | excluded | — | productions | — | not-worth-exposing | — | Production orders and charging belong in the provider dashboard. |
| public_remove_order_item | DELETE | /v1/productions/orders/{order_id}/items/{item_id} | excluded | — | productions | — | not-worth-exposing | — | Production orders and charging belong in the provider dashboard. |
| public_submit_order | POST | /v1/productions/orders/{order_id}/submit | excluded | — | productions | — | not-worth-exposing | — | Production orders and charging belong in the provider dashboard. |
| public_update_order | PATCH | /v1/productions/orders/{order_id} | excluded | — | productions | — | not-worth-exposing | — | Production orders and charging belong in the provider dashboard. |
| public_upsert_order_item | POST | /v1/productions/orders/{order_id}/items | excluded | — | productions | — | not-worth-exposing | — | Production orders and charging belong in the provider dashboard. |
| query_agent_knowledge_base_rag_route | POST | /v1/convai/agents/{agent_id}/knowledge-base/rag-query | admitted | 1 | agents | query_knowledge | missing | — | No existing tool maps to this exact HTTP operation. |
| rag_index_status | POST | /v1/convai/knowledge-base/{documentation_id}/rag-index | admitted | 1 | knowledge-base | create | covered | @mindstone/mcp-server-elevenlabs-agents:rebuild_knowledge_base_rag_index | Supports documentation_id and the complete pinned two-value embedding-model enum; supplies the local default e5_mistral_7b_instruct when model is omitted. |
| rebase_branch_onto_main | POST | /v1/convai/agents/{agent_id}/branches/{branch_id}/rebase | planned | 7 | agents | — | missing | — | No existing tool maps to this exact HTTP operation. |
| rebase_preview_route | GET | /v1/convai/agents/{agent_id}/branches/{branch_id}/rebase-preview | planned | 7 | agents | — | missing | — | No existing tool maps to this exact HTTP operation. |
| redirect_to_mintlify | GET | /docs | excluded | — | engineering | — | not-worth-exposing | — | Documentation redirect; no provider resource operation. Documentation or deprecated routes with explicitly described replacements. |
| refresh_url_document_route | POST | /v1/convai/knowledge-base/{documentation_id}/refresh | admitted | 1 | knowledge-base | change | missing | — | No existing tool maps to this exact HTTP operation. |
| register_twilio_call | POST | /v1/convai/twilio/register-call | planned | 8 | twilio | — | missing | — | No existing tool maps to this exact HTTP operation. |
| remove_mcp_server_tool_approval_route | DELETE | /v1/convai/mcp-servers/{mcp_server_id}/tool-approvals/{tool_name} | planned | 7 | mcp-servers | — | missing | — | No existing tool maps to this exact HTTP operation. |
| remove_mcp_tool_config_override_route | DELETE | /v1/convai/mcp-servers/{mcp_server_id}/tool-configs/{tool_name} | planned | 7 | mcp-servers | — | missing | — | No existing tool maps to this exact HTTP operation. |
| remove_member | POST | /v1/workspace/groups/{group_id}/members/remove | excluded | — | identity_and_seats | — | not-worth-exposing | — | Identity, membership and seat administration belongs in the provider dashboard. |
| remove_procedure_route | DELETE | /v1/convai/agents/{agent_id}/branches/{branch_id}/procedures/{procedure_id} | planned | 7 | agents | — | missing | — | No existing tool maps to this exact HTTP operation. |
| remove_rules | POST | /v1/pronunciation-dictionaries/{pronunciation_dictionary_id}/remove-rules | planned | 9 | pronunciation-dictionaries | — | missing | — | No existing tool maps to this exact HTTP operation. |
| remove_voice_from_user_voice_collection | DELETE | /v1/voices/collections/{collection_id}/voice/{voice_id} | planned | 9 | voices | — | missing | — | No existing tool maps to this exact HTTP operation. |
| render | POST | /v1/dubbing/resource/{dubbing_id}/render/{language} | planned | 9 | dubbing | — | missing | — | No existing tool maps to this exact HTTP operation. |
| replicate_voice_to_isolated_environment | POST | /v1/voices/{voice_id}/replicate-to-isolated-environment | planned | 9 | voices | — | missing | — | No existing tool maps to this exact HTTP operation. |
| request_pvc_manual_verification | POST | /v1/voices/pvc/{voice_id}/verification | planned | 9 | voices | — | missing | — | No existing tool maps to this exact HTTP operation. |
| requests_list | POST | /v1/workspace/analytics/requests | planned | 10 | workspace/analytics | — | missing | — | No existing tool maps to this exact HTTP operation. |
| resolve_conversation_reference_route | GET | /v1/convai/conversations/resolve | planned | 7 | conversations | — | missing | — | No existing tool maps to this exact HTTP operation. |
| resubmit_tests_route | POST | /v1/convai/test-invocations/{test_invocation_id}/resubmit | admitted | 1 | test-invocations | tests | missing | — | No existing tool maps to this exact HTTP operation. |
| retry_batch_call | POST | /v1/convai/batch-calling/{batch_id}/retry | planned | 8 | batch-calling | — | covered | @mindstone/mcp-server-elevenlabs-agents:retry_batch_call | Retries by batch_id on the exact endpoint; there are no other current request controls. |
| run_agent_test_suite_route | POST | /v1/convai/agents/{agent_id}/run-tests | admitted | 1 | agents | tests | missing | — | No existing tool maps to this exact HTTP operation. |
| run_conversation_analysis | POST | /v1/convai/conversations/{conversation_id}/analysis/run | planned | 7 | conversations | — | missing | — | No existing tool maps to this exact HTTP operation. |
| run_conversation_evaluations | POST | /v1/convai/conversations/{conversation_id}/analysis/evaluations/run | planned | 7 | conversations | — | missing | — | No existing tool maps to this exact HTTP operation. |
| run_conversation_simulation_route | POST | /v1/convai/agents/{agent_id}/simulate-conversation | excluded | — | agents | — | partial | @mindstone/mcp-server-elevenlabs-agents:simulate_conversation | Removed direct simulation. Saved Tests replace the workflow; their inputs and effects differ. Calls deprecated direct simulation with agent_id, simulation_specification and new_turns_limit. Saved Tests are different operations; current execution is not established. Replacement IDs: create_agent_response_test_route, run_agent_test_suite_route, get_test_invocation_route |
| run_conversation_simulation_route_stream | POST | /v1/convai/agents/{agent_id}/simulate-conversation/stream | excluded | — | agents | — | not-worth-exposing | — | Removed direct streaming simulation. Saved Tests replace the workflow without equivalent streaming semantics. Documentation or deprecated routes with explicitly described replacements. Replacement IDs: create_agent_response_test_route, run_agent_test_suite_route, get_test_invocation_route |
| run_pvc_voice_training | POST | /v1/voices/pvc/{voice_id}/train | planned | 9 | voices | — | missing | — | No existing tool maps to this exact HTTP operation. |
| search_groups | GET | /v1/workspace/groups/search | excluded | — | identity_and_seats | — | not-worth-exposing | — | Identity, membership and seat administration belongs in the provider dashboard. |
| search_knowledge_base_content_route | GET | /v1/convai/knowledge-base/search | admitted | 1 | knowledge-base | read | missing | — | No existing tool maps to this exact HTTP operation. |
| separate_song_stems | POST | /v1/music/stem-separation | planned | 9 | music | — | missing | — | No existing tool maps to this exact HTTP operation. |
| set_conversation_group_route | PUT | /v1/convai/realtime/conversations/{conversation_id}/conversation-group | planned | 8 | realtime | — | missing | — | No existing tool maps to this exact HTTP operation. |
| set_rules | POST | /v1/pronunciation-dictionaries/{pronunciation_dictionary_id}/set-rules | planned | 9 | pronunciation-dictionaries | — | missing | — | No existing tool maps to this exact HTTP operation. |
| set_third_party_disabling_policy | POST | /v1/workspaces/api-keys/third-party-disabling | excluded | — | account_and_keys | — | not-worth-exposing | — | Credential administration belongs in the provider dashboard. |
| share_resource_endpoint | POST | /v1/workspace/resources/{resource_id}/share | planned | 10 | workspace/resources | — | missing | — | No existing tool maps to this exact HTTP operation. |
| smart_search_conversation_messages_route | GET | /v1/convai/conversations/messages/smart-search | planned | 7 | conversations | — | missing | — | No existing tool maps to this exact HTTP operation. |
| smb_activate_customer_facing_agent | POST | /v1/reception/customer-facing-agents/{agent_id}/activate | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_add_agent_procedure | POST | /v1/reception/customer-facing-agents/{agent_id}/procedures | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_add_agent_rule | POST | /v1/reception/customer-facing-agents/{agent_id}/rules | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_add_transfer_rule | POST | /v1/reception/customer-facing-agents/{agent_id}/transfer-rules | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_add_url_source | POST | /v1/reception/knowledge-sources/urls | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_adjust_product_stock | POST | /v1/reception/products/{product_id}/stock/adjust | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_assign_phone_number | POST | /v1/reception/phone-numbers/assignments | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_assign_reseller_tier | POST | /v1/reception/reseller/workspaces/{workspace_id}/subscription | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_cancel_reseller_pending_downgrade | POST | /v1/reception/reseller/workspaces/{workspace_id}/subscription/cancel-downgrade | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_cancel_team_invite | DELETE | /v1/reception/team/invites | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_change_reseller_tier | PATCH | /v1/reception/reseller/workspaces/{workspace_id}/subscription | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_confirm_service_update | POST | /v1/reception/services/{service_id}/confirm-update | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_create_asset | POST | /v1/reception/assets | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_create_holiday | POST | /v1/reception/holidays | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_create_location | POST | /v1/reception/locations | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_create_product | POST | /v1/reception/products | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_create_service | POST | /v1/reception/services | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_create_staff_member | POST | /v1/reception/staff | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_delete_agent_procedure | DELETE | /v1/reception/customer-facing-agents/{agent_id}/procedures/{procedure_id} | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_delete_agent_rule | DELETE | /v1/reception/customer-facing-agents/{agent_id}/rules/{rule_id} | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_delete_asset | DELETE | /v1/reception/assets/{asset_id} | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_delete_holiday | DELETE | /v1/reception/holidays/{holiday_id} | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_delete_knowledge_source | DELETE | /v1/reception/knowledge-sources/{source_id} | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_delete_location | DELETE | /v1/reception/locations/{location_id} | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_delete_product | DELETE | /v1/reception/products/{product_id} | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_delete_service | DELETE | /v1/reception/services/{service_id} | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_delete_staff_member | DELETE | /v1/reception/staff/{staff_id} | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_delete_transfer_rule | DELETE | /v1/reception/customer-facing-agents/{agent_id}/transfer-rules/{rule_id} | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_get_agent_info | GET | /v1/reception/agent-info | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_get_asset | GET | /v1/reception/assets/{asset_id} | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_get_holiday | GET | /v1/reception/holidays/{holiday_id} | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_get_knowledge_source | GET | /v1/reception/knowledge-sources/{source_id} | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_get_location | GET | /v1/reception/locations/{location_id} | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_get_product | GET | /v1/reception/products/{product_id} | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_get_reseller_invoice | GET | /v1/reception/reseller/billing/invoices/{invoice_id} | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_get_service | GET | /v1/reception/services/{service_id} | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_get_staff_member | GET | /v1/reception/staff/{staff_id} | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_invite_team_member | POST | /v1/reception/team/invites | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_list_agent_procedures | GET | /v1/reception/customer-facing-agents/{agent_id}/procedures | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_list_assets | GET | /v1/reception/assets | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_list_customer_facing_agents | GET | /v1/reception/customer-facing-agents | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_list_holidays | GET | /v1/reception/holidays | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_list_knowledge_sources | GET | /v1/reception/knowledge-sources | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_list_locations | GET | /v1/reception/locations | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_list_products | GET | /v1/reception/products | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_list_reseller_invoices | GET | /v1/reception/reseller/billing/invoices | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_list_reseller_tier_ladder | GET | /v1/reception/reseller/tier-ladder | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_list_reseller_upcoming_payments | GET | /v1/reception/reseller/billing/upcoming | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_list_reseller_workspaces | GET | /v1/reception/reseller/workspaces | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_list_services | GET | /v1/reception/services | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_list_staff | GET | /v1/reception/staff | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_list_team_invites | GET | /v1/reception/team/invites | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_list_team_members | GET | /v1/reception/team/members | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_list_workspace_phone_assignments | GET | /v1/reception/phone-numbers/assignments | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_reassign_phone_to_agent | PATCH | /v1/reception/phone-numbers/assignments/{phone_assignment_id} | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_release_phone_assignment | DELETE | /v1/reception/phone-numbers/assignments/{phone_assignment_id} | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_remove_team_member | DELETE | /v1/reception/team/members/{user_id} | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_reseller_complete_workspace_onboarding | POST | /v1/reception/reseller/workspaces/{workspace_id}/complete-onboarding | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_reseller_provision_workspace | POST | /v1/reception/reseller/workspaces | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_restore_reseller_subscription | POST | /v1/reception/reseller/workspaces/{workspace_id}/subscription/restore | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_unassign_reseller_tier | DELETE | /v1/reception/reseller/workspaces/{workspace_id}/subscription | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_update_agent_info | PUT | /v1/reception/agent-info | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_update_agent_procedure | PUT | /v1/reception/customer-facing-agents/{agent_id}/procedures/{procedure_id} | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_update_agent_rule | PUT | /v1/reception/customer-facing-agents/{agent_id}/rules/{rule_id} | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_update_asset | PUT | /v1/reception/assets/{asset_id} | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_update_customer_facing_agent | PATCH | /v1/reception/customer-facing-agents/{agent_id} | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_update_holiday | PUT | /v1/reception/holidays/{holiday_id} | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_update_location | PUT | /v1/reception/locations/{location_id} | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_update_product | PUT | /v1/reception/products/{product_id} | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_update_product_stock | PATCH | /v1/reception/products/{product_id}/stock | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_update_service | PUT | /v1/reception/services/{service_id} | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_update_staff_member | PUT | /v1/reception/staff/{staff_id} | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_update_team_member_role | PATCH | /v1/reception/team/members/{user_id} | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_update_transfer_rule | PUT | /v1/reception/customer-facing-agents/{agent_id}/transfer-rules/{rule_id} | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| smb_upload_knowledge_source | POST | /v1/reception/knowledge-sources | excluded | — | reception | — | not-worth-exposing | — | Separate receptionist and reseller commercial product. |
| sound_generation | POST | /v1/sound-generation | planned | 9 | sound-generation | — | partial | @mindstone/mcp-server-elevenlabs:generate_sound_effect | Maps prompt to text and supports duration_seconds and prompt_influence; current provider model and loop fields are not exposed. |
| speech_to_speech_full | POST | /v1/voice-changer/{voice_id} | planned | 9 | voice-changer | — | partial | @mindstone/mcp-server-elevenlabs:speech_to_speech | Legacy tool calls /v1/speech-to-speech/{voice_id}; the pinned operation uses /v1/voice-changer/{voice_id}. Not verified equivalent; audio, model_id, settings and background-noise controls are only partial coverage. |
| speech_to_speech_stream | POST | /v1/voice-changer/{voice_id}/stream | planned | 9 | voice-changer | — | missing | — | No existing tool maps to this exact HTTP operation. |
| speech_to_text | POST | /v1/speech-to-text | planned | 9 | speech-to-text | — | partial | @mindstone/mcp-server-elevenlabs:transcribe_audio | Supports a local multipart file, model_id, language, diarization and timestamp controls; omits current URL, webhook and other transcription options. |
| start_speaker_separation | POST | /v1/voices/pvc/{voice_id}/samples/{sample_id}/separate-speakers | planned | 9 | voices | — | missing | — | No existing tool maps to this exact HTTP operation. |
| stream_chapter_snapshot_audio | POST | /v1/studio/projects/{project_id}/chapters/{chapter_id}/snapshots/{chapter_snapshot_id}/stream | planned | 10 | studio | — | missing | — | No existing tool maps to this exact HTTP operation. |
| stream_compose | POST | /v1/music/stream | planned | 9 | music | — | missing | — | No existing tool maps to this exact HTTP operation. |
| stream_project_snapshot_archive_endpoint | POST | /v1/studio/projects/{project_id}/snapshots/{project_snapshot_id}/archive | planned | 10 | studio | — | missing | — | No existing tool maps to this exact HTTP operation. |
| stream_project_snapshot_audio_endpoint | POST | /v1/studio/projects/{project_id}/snapshots/{project_snapshot_id}/stream | planned | 10 | studio | — | missing | — | No existing tool maps to this exact HTTP operation. |
| submit_merge_proposal_review_route | POST | /v1/convai/agents/{agent_id}/merge-proposals/{merge_proposal_id}/reviews | planned | 7 | agents | — | missing | — | No existing tool maps to this exact HTTP operation. |
| text_search_conversation_messages_route | GET | /v1/convai/conversations/messages/text-search | planned | 7 | conversations | — | missing | — | No existing tool maps to this exact HTTP operation. |
| text_to_dialogue | POST | /v1/text-to-dialogue | planned | 9 | text-to-dialogue | — | partial | @mindstone/mcp-server-elevenlabs:text_to_dialogue | Supports dialogue inputs, model_id, language_code and seed; settings, context, pronunciation locators and other current controls and timestamp/stream variants are absent. |
| text_to_dialogue_full_with_timestamps | POST | /v1/text-to-dialogue/with-timestamps | planned | 9 | text-to-dialogue | — | missing | — | No existing tool maps to this exact HTTP operation. |
| text_to_dialogue_stream | POST | /v1/text-to-dialogue/stream | planned | 9 | text-to-dialogue | — | missing | — | No existing tool maps to this exact HTTP operation. |
| text_to_dialogue_stream_with_timestamps | POST | /v1/text-to-dialogue/stream/with-timestamps | planned | 9 | text-to-dialogue | — | missing | — | No existing tool maps to this exact HTTP operation. |
| text_to_speech_full | POST | /v1/text-to-speech/{voice_id} | planned | 9 | text-to-speech | — | partial | @mindstone/mcp-server-elevenlabs:generate_speech | Supports voice_id, text, model_id, selected voice settings, seed, output_format and pronunciation locators; omits other current synthesis fields and streaming variants. |
| text_to_speech_full_with_timestamps | POST | /v1/text-to-speech/{voice_id}/with-timestamps | planned | 9 | text-to-speech | — | partial | @mindstone/mcp-server-elevenlabs:generate_speech_with_timestamps | Supports voice_id, text, model_id, selected voice settings, seed, output_format and pronunciation locators; omits other current synthesis fields and streaming variants. |
| text_to_speech_stream | POST | /v1/text-to-speech/{voice_id}/stream | planned | 9 | text-to-speech | — | missing | — | No existing tool maps to this exact HTTP operation. |
| text_to_speech_stream_with_timestamps | POST | /v1/text-to-speech/{voice_id}/stream/with-timestamps | planned | 9 | text-to-speech | — | missing | — | No existing tool maps to this exact HTTP operation. |
| text_to_voice | POST | /v1/text-to-voice/create-previews | planned | 9 | text-to-voice | — | missing | — | No existing tool maps to this exact HTTP operation. |
| text_to_voice_design | POST | /v1/text-to-voice/design | planned | 9 | text-to-voice | — | partial | @mindstone/mcp-server-elevenlabs:design_voice | Supports voice_description, optional text, model_id and auto_generate_text; output_format, seed, loudness, guidance_scale and other current preview controls are absent. |
| text_to_voice_preview_stream | GET | /v1/text-to-voice/{generated_voice_id}/stream | planned | 9 | text-to-voice | — | missing | — | No existing tool maps to this exact HTTP operation. |
| text_to_voice_remix | POST | /v1/text-to-voice/{voice_id}/remix | planned | 9 | text-to-voice | — | missing | — | No existing tool maps to this exact HTTP operation. |
| transcribe | POST | /v1/dubbing/resource/{dubbing_id}/transcribe | planned | 9 | dubbing | — | missing | — | No existing tool maps to this exact HTTP operation. |
| translate | POST | /v1/dubbing/resource/{dubbing_id}/translate | planned | 9 | dubbing | — | missing | — | No existing tool maps to this exact HTTP operation. |
| unassign_conversation_tag_route | DELETE | /v1/convai/conversations/{conversation_id}/tags/{tag_id} | planned | 7 | conversations | — | missing | — | No existing tool maps to this exact HTTP operation. |
| unshare_resource_endpoint | POST | /v1/workspace/resources/{resource_id}/unshare | planned | 10 | workspace/resources | — | missing | — | No existing tool maps to this exact HTTP operation. |
| update_agent_conversation_ticket_route | PATCH | /v1/convai/triage-tickets/{agentqa_ticket_id} | planned | 7 | triage-tickets | — | missing | — | No existing tool maps to this exact HTTP operation. |
| update_agent_response_test_route | PUT | /v1/convai/agent-testing/{test_id} | admitted | 1 | agent-testing | change | missing | — | No existing tool maps to this exact HTTP operation. |
| update_agent_test_folder_route | PATCH | /v1/convai/agent-testing/folders/{folder_id} | planned | 7 | agent-testing | — | missing | — | No existing tool maps to this exact HTTP operation. |
| update_analysis_item_attachments_route | PATCH | /v1/convai/analysis-items/{analysis_item_id}/attachments | planned | 7 | analysis-items | — | missing | — | No existing tool maps to this exact HTTP operation. |
| update_analysis_item_route | PATCH | /v1/convai/analysis-items/{analysis_item_id} | planned | 7 | analysis-items | — | missing | — | No existing tool maps to this exact HTTP operation. |
| update_auth_connection | PATCH | /v1/workspace/auth-connections/{auth_connection_id} | planned | 10 | workspace/auth-connections | — | missing | — | No existing tool maps to this exact HTTP operation. |
| update_branch_route | PATCH | /v1/convai/agents/{agent_id}/branches/{branch_id} | planned | 7 | agents | — | missing | — | No existing tool maps to this exact HTTP operation. |
| update_conversation_group_route | PATCH | /v1/convai/realtime/conversation-groups/{conversation_group_id} | planned | 8 | realtime | — | missing | — | No existing tool maps to this exact HTTP operation. |
| update_conversation_tag_route | PATCH | /v1/convai/tags/{tag_id} | planned | 7 | tags | — | missing | — | No existing tool maps to this exact HTTP operation. |
| update_dashboard_settings_route | PATCH | /v1/convai/settings/dashboard | planned | 7 | settings | — | missing | — | No existing tool maps to this exact HTTP operation. |
| update_document_route | PATCH | /v1/convai/knowledge-base/{documentation_id} | admitted | 1 | knowledge-base | change | missing | — | No existing tool maps to this exact HTTP operation. |
| update_environment_variable | PATCH | /v1/convai/environment-variables/{env_var_id} | planned | 7 | environment-variables | — | missing | — | No existing tool maps to this exact HTTP operation. |
| update_file_document_route | PATCH | /v1/convai/knowledge-base/{documentation_id}/update-file | admitted | 1 | knowledge-base | change | missing | — | No existing tool maps to this exact HTTP operation. |
| update_finetune | PATCH | /v1/music/finetunes/{finetune_id} | planned | 9 | music | — | missing | — | No existing tool maps to this exact HTTP operation. |
| update_mcp_server_approval_policy_route | PATCH | /v1/convai/mcp-servers/{mcp_server_id}/approval-policy | planned | 7 | mcp-servers | — | missing | — | No existing tool maps to this exact HTTP operation. |
| update_mcp_server_config_route | PATCH | /v1/convai/mcp-servers/{mcp_server_id} | planned | 7 | mcp-servers | — | missing | — | No existing tool maps to this exact HTTP operation. |
| update_mcp_tool_config_override_route | PATCH | /v1/convai/mcp-servers/{mcp_server_id}/tool-configs/{tool_name} | planned | 7 | mcp-servers | — | missing | — | No existing tool maps to this exact HTTP operation. |
| update_merge_proposal_route | PATCH | /v1/convai/agents/{agent_id}/merge-proposals/{merge_proposal_id} | planned | 7 | agents | — | missing | — | No existing tool maps to this exact HTTP operation. |
| update_phone_number_route | PATCH | /v1/convai/phone-numbers/{phone_number_id} | planned | 8 | phone-numbers | — | partial | @mindstone/mcp-server-elevenlabs-agents:update_phone_number | Updates selected number fields; not every provider setting is exposed. |
| update_procedure_draft_route | PATCH | /v1/convai/agents/{agent_id}/branches/{branch_id}/procedures/{procedure_id}/draft | planned | 7 | agents | — | missing | — | No existing tool maps to this exact HTTP operation. |
| update_pronunciation_dictionaries | POST | /v1/studio/projects/{project_id}/pronunciation-dictionaries | planned | 10 | studio | — | missing | — | No existing tool maps to this exact HTTP operation. |
| update_secret_route | PATCH | /v1/convai/secrets/{secret_id} | planned | 7 | secrets | — | missing | — | No existing tool maps to this exact HTTP operation. |
| update_segment_language | PATCH | /v1/dubbing/resource/{dubbing_id}/segment/{segment_id}/{language} | planned | 9 | dubbing | — | missing | — | No existing tool maps to this exact HTTP operation. |
| update_settings_route | PATCH | /v1/convai/settings | planned | 7 | settings | — | missing | — | No existing tool maps to this exact HTTP operation. |
| update_speaker | PATCH | /v1/dubbing/resource/{dubbing_id}/speaker/{speaker_id} | planned | 9 | dubbing | — | missing | — | No existing tool maps to this exact HTTP operation. |
| update_speech_engine | PATCH | /v1/speech-engine/{speech_engine_id} | planned | 10 | speech-engine | — | missing | — | No existing tool maps to this exact HTTP operation. |
| update_test_invocation_route | PATCH | /v1/convai/test-invocations/{test_invocation_id} | planned | 7 | test-invocations | — | missing | — | No existing tool maps to this exact HTTP operation. |
| update_tool_route | PATCH | /v1/convai/tools/{tool_id} | admitted | 1 | tools | change | missing | — | No existing tool maps to this exact HTTP operation. |
| update_user_voice_collection | PATCH | /v1/voices/collections/{collection_id} | planned | 9 | voices | — | missing | — | No existing tool maps to this exact HTTP operation. |
| update_whatsapp_account | PATCH | /v1/convai/whatsapp-accounts/{phone_number_id} | planned | 8 | whatsapp-accounts | — | missing | — | No existing tool maps to this exact HTTP operation. |
| update_workspace_member | POST | /v1/workspace/members | excluded | — | identity_and_seats | — | not-worth-exposing | — | Identity, membership and seat administration belongs in the provider dashboard. |
| update_workspace_member_usage_limit | PUT | /v1/workspace/members/{user_id}/usage-limit | excluded | — | identity_and_seats | — | not-worth-exposing | — | Identity, membership and seat administration belongs in the provider dashboard. |
| upload_asset | POST | /v1/assets | planned | 10 | assets | — | missing | — | No existing tool maps to this exact HTTP operation. |
| upload_file_route | POST | /v1/convai/conversations/{conversation_id}/files | planned | 7 | conversations | — | missing | — | No existing tool maps to this exact HTTP operation. |
| upload_song | POST | /v1/music/upload | planned | 9 | music | — | missing | — | No existing tool maps to this exact HTTP operation. |
| usage_by_product_over_time | POST | /v1/workspace/analytics/query/usage-by-product-over-time | planned | 10 | workspace/analytics | — | partial | @mindstone/mcp-server-elevenlabs:get_usage_stats | Maps days_back, interval and group_by to start_time, end_time, interval_seconds and group_by; provider filters and time_zone are absent. Returns summarized credit usage rather than the entire provider response. |
| usage_characters | GET | /v1/usage/character-stats | planned | 9 | usage | — | missing | — | No existing tool maps to this exact HTTP operation. |
| verify_pvc_voice_captcha | POST | /v1/voices/pvc/{voice_id}/captcha | planned | 9 | voices | — | missing | — | No existing tool maps to this exact HTTP operation. |
| video_to_music | POST | /v1/music/video-to-music | planned | 9 | music | — | missing | — | No existing tool maps to this exact HTTP operation. |
| whatsapp_outbound_call | POST | /v1/convai/whatsapp/outbound-call | planned | 8 | whatsapp | — | missing | — | No existing tool maps to this exact HTTP operation. |
| whatsapp_outbound_message | POST | /v1/convai/whatsapp/outbound-message | planned | 8 | whatsapp | — | missing | — | No existing tool maps to this exact HTTP operation. |
| workspace_usage | POST | /v1/workspace/analytics/usage | planned | 10 | workspace/analytics | — | missing | — | No existing tool maps to this exact HTTP operation. |
