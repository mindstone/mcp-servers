#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { credentialIdentifiers, isCredentialKey } from '../src/api-credential-keys.mjs';
import { binaryFileShape, multipartFieldEncoding } from '../src/api-multipart-shapes.mjs';
import { audioRepresentation, base64AudioSchema, multipartResponseSchema, binaryExtensions } from '../src/api-media.mjs';

export const PINNED_SOURCE = Object.freeze({
  url: 'https://api.elevenlabs.io/openapi.json',
  retrieved_at: '2026-11-08T21:07:54.389549+00:00',
  sha256: '794bccdc06ac77a90e576807fac9d00204f5af6bba115a84bfd71ace208c11dc',
  bytes: 2675026, paths: 375, operations: 515,
});

export const SCHEMA_METADATA_KEYWORDS = Object.freeze([
  'example', 'discriminator', 'optional', 'name', 'embed', 'max_items',
  'x-fern-enum', 'x-convai-client-override', 'x-fern-ignore',
  'x-convai-soft-override-disallowed', 'x-convai-language-override',
  'x-convai-runtime-override', 'x-convai-override-disallowed',
]);
export const SCHEMA_FORMATS = Object.freeze(['date', 'date-time', 'uri', 'zoneinfo']);
export const VALIDATOR_OPTIONS = Object.freeze({
  strict: true, strictTypes: false, strictTuples: true, strictRequired: true,
  allowUnionTypes: false, allErrors: true, coerceTypes: false,
  useDefaults: false, removeAdditional: false,
});

const idsByProfile = {
  read: 'get_agents_route get_agent_route list_available_llms get_tools_route get_tool_route get_tool_dependent_agents_route get_knowledge_base_list_route get_documentation_from_knowledge_base get_knowledge_base_content get_documentation_chunks_from_knowledge_base search_knowledge_base_content_route get_knowledge_base_dependent_agents get_rag_indexes get_agent_response_test_route list_chat_response_tests_route list_test_invocations_route get_test_invocation_route',
  create: 'create_agent_route duplicate_agent_route add_tool_route create_text_document_route create_url_document_route create_file_document_route create_folder_route rag_index_status create_agent_response_test_route',
  change: 'patch_agent_settings_route update_tool_route update_document_route update_file_document_route refresh_url_document_route update_agent_response_test_route',
  delete: 'delete_agent_route delete_tool_route delete_knowledge_base_document delete_chat_response_test_route',
  tests: 'run_agent_test_suite_route cancel_test_invocation_route resubmit_tests_route',
  query_knowledge: 'query_agent_knowledge_base_rag_route',
};
const reviewedGetCreate = ['get_conversation_signed_link', 'get_signed_url_deprecated', 'get_livekit_token'];
const credentialIssuers = [...reviewedGetCreate, 'create_realtime_session', 'register_twilio_call', 'get_single_use_token'];
const realtimeAuthorizationPath = ['session', 'tools', '*', 'authorization'];
const stage81Profiles = { create: [...reviewedGetCreate, 'create_realtime_session'].join(' '), place_call: 'register_twilio_call' };
const stage82Profiles = {
  read: 'list_phone_numbers_route get_phone_number_route list_sip_messages list_phone_numbers_page_route get_whatsapp_account list_whatsapp_accounts list_conversation_groups_route get_conversation_group_route',
  create: 'create_conversation_group_route',
  change: 'create_phone_number_route update_phone_number_route update_whatsapp_account update_conversation_group_route set_conversation_group_route',
  delete: 'delete_phone_number_route delete_whatsapp_account delete_conversation_group_route clear_conversation_group_route',
};
const stage83Profiles = {
  read: 'get_workspace_batch_calls get_batch_call export_batch_call',
  change: 'cancel_batch_call', delete: 'delete_batch_call',
  place_call: 'handle_twilio_outbound_call handle_exotel_outbound_call handle_sip_trunk_outbound_call whatsapp_outbound_call whatsapp_outbound_message create_batch_call retry_batch_call',
};
const stage76Profiles = { read: 'get_agent_summaries_route', create: 'upload_file_route', change: 'post_agent_avatar_route post_agent_hold_audio_route' };
const stage75Profiles = {
  read: 'get_secret_dependencies_route get_secret_route get_secrets_route get_environment_variable list_environment_variables get_mcp_route get_mcp_tool_config_override_route list_mcp_server_tools_route list_mcp_servers_route',
  create: 'create_secret_route create_environment_variable',
  change: 'add_mcp_tool_config_override_route update_secret_route add_mcp_server_tool_approval_route create_mcp_server_route update_mcp_server_approval_policy_route update_mcp_server_config_route update_mcp_tool_config_override_route',
  delete: 'delete_secret_route delete_environment_variable update_environment_variable delete_mcp_server_route remove_mcp_server_tool_approval_route remove_mcp_tool_config_override_route',
};
const stage7Profiles = {
  read: 'get_agent_knowledge_base_size get_agent_llm_expected_cost_calculation get_agent_response_tests_summaries_route get_agent_test_folder_route get_analysis_item_dependent_agents_route get_analysis_item_route get_conversation_tag_route get_conversation_users_route get_dashboard_settings_route get_live_count get_public_llm_expected_cost_calculation get_settings_route get_tool_executions_route list_analysis_item_versions_route list_analysis_items_route list_conversation_tags_route list_environments get_branch_route get_branches_route merge_preview_route rebase_preview_route get_version_metadata_route list_agent_deployments_route get_merge_proposal_route list_merge_proposals_route compile_procedures_route get_procedure_route get_procedure_draft_route list_procedures_route get_agent_link_route get_agent_topics_route get_agent_widget_route get_assignable_users_route get_crawl_job_route list_crawl_jobs_route get_rag_index_overview get_agent_knowledge_base_summaries_route get_documentation_chunk_from_knowledge_base get_knowledge_base_bulk_dependent_agents_route get_knowledge_base_source_file_url get_conversation_audio_route get_conversation_histories_route get_conversation_history_route get_conversation_sip_messages get_conversation_summary_route resolve_conversation_reference_route smart_search_conversation_messages_route text_search_conversation_messages_route get_agent_conversation_ticket_route list_workspace_conversation_tickets_route list_agent_conversation_tickets_route',
  create: 'copy_analysis_item_route create_agent_test_folder_route create_analysis_item_route create_conversation_tag_route create_environment create_branch_route create_merge_proposal_route add_merge_proposal_comment_route create_procedure_route create_crawl_job_route get_or_create_rag_indexes add_ticket_comment_route add_turn_comment_route create_manual_agent_ticket_route',
  change: 'agent_testing_bulk_move_route update_agent_test_folder_route update_analysis_item_attachments_route update_analysis_item_route update_conversation_tag_route update_dashboard_settings_route update_settings_route update_test_invocation_route update_branch_route create_agent_draft_route merge_branch_into_target rebase_branch_onto_main create_agent_deployment_route update_merge_proposal_route accept_merge_proposal_route submit_merge_proposal_review_route update_procedure_draft_route post_knowledge_base_move_route post_knowledge_base_bulk_move_route assign_conversation_tags_route post_conversation_feedback_route run_conversation_analysis run_conversation_evaluations create_agent_conversation_ticket_route merge_agent_conversation_tickets_route update_agent_conversation_ticket_route',
  delete: 'delete_agent_test_folder_route delete_analysis_item_route delete_conversation_tag_route delete_environment delete_agent_draft_route remove_procedure_route delete_procedure_draft_route delete_rag_index post_knowledge_base_bulk_delete_route cancel_crawl_job_route cancel_file_upload_route delete_conversation_route unassign_conversation_tag_route delete_agent_conversation_ticket_route delete_agent_hold_audio_route',
};
const stage92Profiles = { read: 'get_similar_library_voices', create: 'add_from_file', run_job: 'audio_isolation speech_to_speech_full speech_to_text forced_alignment' };
const stage91Profiles = { read: 'get_audio_effects_catalog', run_job: 'text_to_speech_full text_to_dialogue sound_generation' };
const stage93Profiles = { read: 'get_pvc_sample_audio get_speaker_audio', run_job: 'text_to_speech_full_with_timestamps text_to_dialogue_full_with_timestamps text_to_voice text_to_voice_design text_to_voice_remix text_to_speech_stream_with_timestamps text_to_dialogue_stream_with_timestamps' };
const stage94Profiles = { run_job: 'compose_detailed' };
const stage95Profiles = { read: 'compose_plan get_finetune get_finetunes', change: 'update_finetune', delete: 'delete_finetune', run_job: 'generate stream_compose upload_song separate_song_stems video_to_music create_finetune' };
const stage96Profiles = {
  read: 'get_models get_user_info get_user_subscription_info get_voices get_user_voices_v2 get_library_voices get_voice_by_id get_voice_accents get_voice_settings get_voice_settings_default get_user_voice_collections get_user_voice_collection text_to_voice_preview_stream',
  create: 'get_single_use_token create_or_update_user_voice_collection add_sharing_voice replicate_voice_to_isolated_environment create_voice',
  change: 'update_user_voice_collection add_voice_to_user_voice_collection edit_voice_settings',
  delete: 'delete_user_voice_collection remove_voice_from_user_voice_collection',
};
const stage97Profiles = {
  read: 'get_audio_from_sample get_pvc_sample_visual_waveform get_pvc_sample_speakers',
  create: 'add_voice create_pvc_voice',
  change: 'edit_voice edit_pvc_voice add_pvc_voice_samples edit_pvc_voice_sample start_speaker_separation run_pvc_voice_training request_pvc_manual_verification',
  delete: 'delete_voice delete_sample delete_pvc_voice_sample',
};
const stage98Profiles = {
  run_job: 'dubbing_project_create dubbing_language_create',
  read: 'dubbing_project_list dubbing_project_get dubbing_language_list dubbing_language_get dubbing_transcript_get dubbing_target_transcript_get',
  delete: 'dubbing_project_delete dubbing_language_delete dubbing_transcript_segment_delete',
  change: 'dubbing_transcript_segment_update dubbing_transcript_segments_update dubbing_transcript_segment_add dubbing_target_transcript_segment_update dubbing_target_transcript_segments_update dubbing_target_transcript_regenerate',
};
const profileTuples = {
  read: [true, false, true, true], create: [false, false, false, true],
  change: [false, true, false, true], delete: [false, true, false, true],
  run_job: [false, false, false, true], tests: [false, true, false, true], query_knowledge: [true, false, false, true], place_call: [false, true, false, true],
};
const annotationNames = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];
export const PROFILE_EFFECTS = Object.fromEntries(Object.entries(profileTuples)
  .map(([profile, tuple]) => [profile, Object.fromEntries(annotationNames.map((key, i) => [key, tuple[i]]))]));
export const PROFILE_TOOLS = Object.freeze({
  read: 'elevenlabs_read_resource', create: 'elevenlabs_create_resource',
  change: 'elevenlabs_change_resource', delete: 'elevenlabs_delete_resource',
  run_job: 'elevenlabs_run_job', tests: 'elevenlabs_run_agent_tests', query_knowledge: 'elevenlabs_query_knowledge', place_call: 'elevenlabs_place_call',
});
const reviewedProfiles = Object.fromEntries([idsByProfile, stage7Profiles, stage75Profiles, stage76Profiles, stage81Profiles, stage82Profiles, stage83Profiles, stage91Profiles, stage92Profiles, stage93Profiles, stage94Profiles, stage95Profiles, stage96Profiles, stage97Profiles, stage98Profiles].flatMap(groups => Object.entries(groups)
  .flatMap(([profile, ids]) => ids.split(' ').map(id => [id, profile]))));

const exclusionGroups = {
  account_and_keys: { prefixes: ['/v1/service-accounts', '/v1/workspaces/api-keys'], count: 9 },
  identity_and_seats: { prefixes: ['/v1/workspace/groups', '/v1/workspace/invites', '/v1/workspace/members'], count: 10 },
  reception: { prefixes: ['/v1/reception'], count: 75 },
  productions: { prefixes: ['/v1/productions'], count: 11 },
  engineering: { prefixes: [], count: 4 },
};
const engineeringExclusions = {
  redirect_to_mintlify: [],
  run_conversation_simulation_route: ['create_agent_response_test_route', 'run_agent_test_suite_route', 'get_test_invocation_route'],
  run_conversation_simulation_route_stream: ['create_agent_response_test_route', 'run_agent_test_suite_route', 'get_test_invocation_route'],
  add_documentation_to_knowledge_base: ['create_file_document_route', 'create_url_document_route', 'get_agent_route', 'patch_agent_settings_route'],
};
export const FAMILY_COUNTS = Object.freeze({
  7: { agents: 38, agent: 2, 'agent-testing': 6, 'test-invocations': 1, 'knowledge-base': 14,
    tools: 1, conversations: 16, tags: 5, 'triage-tickets': 8, 'analysis-items': 9, analytics: 1,
    settings: 4, secrets: 6, 'environment-variables': 5, environments: 3, 'mcp-servers': 13, users: 1, 'llm-usage': 1 },
  8: { 'phone-numbers': 6, 'v2/phone-numbers': 1, 'batch-calling': 7, twilio: 2, exotel: 1,
    'sip-trunk': 1, whatsapp: 2, 'whatsapp-accounts': 4, conversation: 3, realtime: 8 },
  9: { 'text-to-speech': 4, 'text-to-dialogue': 4, 'sound-generation': 1, 'audio-effects': 1,
    'voice-changer': 2, 'audio-isolation': 4, 'speech-to-text': 3, 'forced-alignment': 1,
    music: 13, dubbing: 37, voices: 34, 'voices-v2': 1, 'shared-voices': 1, 'similar-voices': 1,
    'text-to-voice': 5, history: 5, 'pronunciation-dictionaries': 9, models: 1, usage: 1, user: 2, 'single-use-token': 1 },
  10: { studio: 23, 'audio-native': 4, 'speech-engine': 6, flows: 14, assets: 4,
    'workspace/analytics': 3, 'workspace/audit-logs': 1, 'workspace/auth-connections': 4,
    'workspace/resources': 3, 'workspace/webhooks': 4 },
});

const text = z.string().min(1);
const effectsSchema = z.object(Object.fromEntries(annotationNames.map(key => [key, z.boolean()]))).strict();
const sourceSchema = z.object({
  url: z.string().url(), retrieved_at: z.string().datetime({ offset: true }),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().positive(),
  paths: z.number().int().nonnegative(), operations: z.number().int().positive(),
}).strict();
const profileSchema = z.enum(['read', 'create', 'change', 'delete', 'tests', 'query_knowledge', 'run_job', 'place_call']);
const aliasSchema = z.object({
  operation_ids: z.array(text).nonempty(), prompt_path: z.array(text).nonempty(),
  own_properties: z.object({ llm_model: z.literal('llm'), knowledge_base_document_ids: z.literal('knowledge_base') }).strict(), reason: text,
}).strict();
const operationSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE']),
  path: z.string().startsWith('/'), status: z.enum(['admitted', 'planned', 'excluded']),
  milestone: z.number().int().positive().nullable(), family: text,
  profile: profileSchema.nullable(), effects: effectsSchema.nullable(), effect_reason: text.nullable(),
  existing_coverage: z.object({
    status: z.enum(['covered', 'partial', 'missing', 'not-worth-exposing']),
    tools: z.array(text), reason: text, evidence: z.array(text),
  }).strict(),
  replacements: z.array(text), exclusion_group: text.optional(), reason: text.optional(),
  discovery_summary: text.optional(), effect_note: text.optional(), manual_pagination: text.optional(),
  base64_audio: base64AudioSchema.optional(), multipart: multipartResponseSchema.optional(), response_format_binding: z.literal('output_format').optional(),
  timeout: z.enum(['standard', 'long']).optional(), reviewed_post_read: text.optional(), reviewed_patch_delete: text.optional(), reviewed_get_create: text.optional(),
  sensitive_request_fields: z.array(z.array(text).nonempty()).nonempty().optional(),
  credential_return_fields: z.array(z.array(text)).nonempty().optional(),
  sensitive_response_fields: z.array(z.array(text).nonempty()).nonempty().optional(),
  file_bindings: z.array(z.object({ field: text, kind: z.union([z.enum(['audio', 'document', 'image']), z.array(z.enum(['audio', 'document', 'image'])).nonempty()]), allowed_media_types: z.array(text).nonempty().optional(), max_bytes: z.number().int().positive().optional(), max_total_bytes: z.number().int().positive().safe().optional() }).strict()).optional(),
  search_aliases: z.array(text).optional(), rank: z.number().int().optional(),
  follow_ups: z.array(text).optional(), examples: z.array(z.record(z.unknown())).optional(),
}).strict();
export const policySchema = z.object({
  schema_version: z.literal(1), source: sourceSchema,
  compatibility_overlay: z.object({
    schema_constraints: text, enum_snapshot_date: z.literal('2026-11-08'), enum_error_advice: text,
    forbidden_aliases: z.array(aliasSchema), alias_behavior: text,
  }).strict(),
  exclusion_groups: z.record(z.object({ prefixes: z.array(text), count: z.number().int().nonnegative(), reason: text }).strict()),
  milestones: z.array(z.object({ number: z.number().int().positive(), version: z.null(), proposed_version: text.optional() }).strict()),
  local_discovery: z.object({ tool: z.literal('elevenlabs_discover_api'), effects: effectsSchema }).strict(),
  reserved_profiles: z.array(z.object({
    profile: z.literal('run_job'), tool: text, milestone: z.number().int().positive(), effects: effectsSchema, reason: text,
  }).strict()),
  family_retry_checks: z.record(z.object({ read: z.union([text, z.object({ unavailable_reason: text }).strict()]), tests: text.optional() }).strict()),
  operations: z.record(operationSchema),
}).strict();

function refuse(construct, detail) {
  throw new Error(`${construct}: ${detail}`);
}
function requireEqual(actual, expected, construct) {
  if (!isDeepStrictEqual(actual, expected)) refuse(construct, `expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}
export function stableJson(value) {
  return JSON.stringify(sortKeys(value), null, 2) + '\n';
}
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]));
  return value;
}
export function originalBytes(input) {
  const bytes = Buffer.from(input);
  return bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
}
export function verifySource(input, expectedSource) {
  const expected = sourceSchema.parse(expectedSource);
  const bytes = originalBytes(input);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== expected.sha256 || bytes.length !== expected.bytes) {
    refuse('source pin mismatch', `expected ${expected.sha256} / ${expected.bytes} bytes, received ${sha256} / ${bytes.length}; provide the pinned input, never silently repin`);
  }
  return bytes;
}
export function matchesPrefix(path, prefix) {
  return path === prefix || path.startsWith(prefix + '/');
}
function classify(id, path) {
  if ([stage81Profiles, stage82Profiles, stage83Profiles].some(groups => Object.values(groups).some(ids => ids.split(' ').includes(id)))) return { status: 'admitted', milestone: 8 };
  if (Object.hasOwn(reviewedProfiles, id)) return { status: 'admitted', milestone: [stage91Profiles, stage92Profiles, stage93Profiles, stage94Profiles, stage95Profiles, stage96Profiles, stage97Profiles, stage98Profiles].some(groups => Object.values(groups).some(ids => ids.split(' ').includes(id))) ? 9 : [stage7Profiles, stage75Profiles, stage76Profiles].some(groups => Object.values(groups).some(ids => ids.split(' ').includes(id))) ? 7 : 1 };
  if (Object.hasOwn(engineeringExclusions, id)) return { status: 'excluded', milestone: null, exclusion_group: 'engineering' };
  for (const [group, { prefixes }] of Object.entries(exclusionGroups)) {
    if (prefixes.some(prefix => matchesPrefix(path, prefix))) return { status: 'excluded', milestone: null, exclusion_group: group };
  }
  for (const family of Object.keys(FAMILY_COUNTS[8])) {
    if (matchesPrefix(path, '/v1/convai/' + family)) return { status: 'planned', milestone: 8, family };
  }
  if (path.startsWith('/v1/convai/')) return { status: 'planned', milestone: 7, family: path.slice('/v1/convai/'.length).split('/')[0] };
  if (path === '/v2/voices') return { status: 'planned', milestone: 9, family: 'voices-v2' };
  for (const milestone of [9, 10]) {
    for (const family of Object.keys(FAMILY_COUNTS[milestone])) {
      if (matchesPrefix(path, '/v1/' + family)) return { status: 'planned', milestone, family };
    }
  }
  refuse('unclassified operation', `${id} ${path}`);
}

export function validatePolicy(raw, rosters, expectedSource = PINNED_SOURCE) {
  const policy = policySchema.parse(raw);
  requireEqual(policy.source, expectedSource, 'policy source pin');
  const entries = Object.entries(policy.operations);
  requireEqual(entries.length, expectedSource.operations, 'policy operation count');
  for (const [id, row] of entries) {
    if (!/^[a-zA-Z0-9_]+$/.test(id)) refuse('operation ID', id);
    const coverage = row.existing_coverage;
    const hasCoverage = ['covered', 'partial'].includes(coverage.status);
    if (hasCoverage !== (coverage.tools.length > 0) || (hasCoverage && coverage.evidence.length === 0)) refuse('coverage evidence', id);
    requireEqual(new Set(coverage.tools).size, coverage.tools.length, `duplicate coverage reference ${id}`);
    for (const ref of coverage.tools) {
      const colon = ref.lastIndexOf(':');
      const pkg = ref.slice(0, colon); const tool = ref.slice(colon + 1);
      if (colon < 0 || !rosters[pkg]?.has(tool)) refuse('unknown coverage tool', `${id}: ${ref}`);
    }
    for (const replacement of row.replacements) {
      if (!Object.hasOwn(policy.operations, replacement)) refuse('replacement reference', `${id}: ${replacement}`);
    }
    for (const followUp of row.follow_ups ?? []) {
      const followUpPolicy = policy.operations[followUp];
      if (followUp === id) refuse('self follow_up', id);
      if (followUpPolicy?.status !== 'admitted') refuse('follow_up must be admitted', `${id}: ${followUp}`);
      if (followUpPolicy.profile !== 'read') refuse('follow_up must be a read operation', `${id}: ${followUp}`);
    }
    if (row.status === 'admitted') {
      if (![1, 7, 8, 9].includes(row.milestone) || row.profile === null || row.effects === null || row.effect_reason === null || row.exclusion_group !== undefined) refuse('admission metadata', id);
      const reviewedProfile = reviewedProfiles[id];
      if (!reviewedProfile || row.profile !== reviewedProfile) refuse('unreviewed effect assignment', id);
      requireEqual(row.effects, PROFILE_EFFECTS[reviewedProfile], `effect annotations ${id}`);
      const floor = { GET: 'read', DELETE: 'delete', PUT: 'change', PATCH: 'change' }[row.method];
      if (floor && floor !== row.profile && !(row.method === 'GET' && row.profile === 'create' && row.reviewed_get_create && reviewedGetCreate.includes(id)) && !(row.method === 'PATCH' && row.profile === 'delete' && row.reviewed_patch_delete)) refuse('method effect floor', `${id}: ${row.method} requires ${floor}`);
      if (row.method !== 'POST' && floor === undefined) refuse('unsupported method', `${id}: ${row.method}`);
      if (row.method === 'POST' && row.profile === 'read' && !row.reviewed_post_read) refuse('unreviewed POST read', id);
      if (row.reviewed_get_create !== undefined && (row.method !== 'GET' || row.profile !== 'create' || !reviewedGetCreate.includes(id))) refuse('misplaced reviewed GET create', id);
      if (row.reviewed_post_read !== undefined && (row.method !== 'POST' || row.profile !== 'read')) refuse('misplaced reviewed POST read', id);
      if (row.reviewed_patch_delete !== undefined && (row.method !== 'PATCH' || row.profile !== 'delete')) refuse('misplaced reviewed PATCH delete', id);
      if (row.manual_pagination !== undefined && (row.method !== 'GET' || row.profile !== 'read')) refuse('invalid manual pagination', id);
      if (credentialIssuers.includes(id) && !row.credential_return_fields) refuse('missing credential return fields', id);
      if (id === 'create_realtime_session' && ['sensitive_request_fields', 'sensitive_response_fields'].some(field => !row[field]?.some(path => isDeepStrictEqual(path, realtimeAuthorizationPath)))) refuse('missing realtime authorization protection', id);
      const retryCheck = policy.family_retry_checks[row.family]?.[row.profile === 'tests' ? 'tests' : 'read'];
      if (typeof retryCheck === 'string') {
        const retryOperation = policy.operations[retryCheck];
        if (!retryOperation || retryOperation.status !== 'admitted' || retryOperation.profile !== 'read' || retryOperation.method !== 'GET') refuse('family retry check must be an admitted GET read', id);
      } else if (!retryCheck) refuse('missing family retry metadata', id);
    } else {
      if (row.multipart !== undefined || row.base64_audio !== undefined || row.response_format_binding !== undefined || row.profile !== null || row.effects !== null || row.effect_reason !== null || row.reviewed_post_read !== undefined || row.manual_pagination !== undefined || row.effect_note !== undefined || row.discovery_summary !== undefined || row.reviewed_patch_delete !== undefined || row.sensitive_request_fields !== undefined || row.sensitive_response_fields !== undefined || row.reviewed_get_create !== undefined || row.credential_return_fields !== undefined) refuse('non-admitted transport metadata', id);
      if (row.status === 'planned' && (![7, 8, 9, 10].includes(row.milestone) || row.exclusion_group !== undefined)) refuse('planned milestone', id);
      if (row.status === 'excluded' && (row.milestone !== null || !row.reason || !Object.hasOwn(policy.exclusion_groups, row.exclusion_group ?? ''))) refuse('exclusion metadata', id);
    }
  }
  const aliases = policy.compatibility_overlay.forbidden_aliases;
  const expectedAliases = [
    { ids: ['create_agent_route', 'patch_agent_settings_route'], path: ['body', 'conversation_config', 'agent', 'prompt'] },
    { ids: ['run_agent_test_suite_route'], path: ['body', 'agent_config_override', 'conversation_config', 'agent', 'prompt'] },
  ];
  requireEqual(aliases.map(rule => ({ ids: rule.operation_ids, path: rule.prompt_path })), expectedAliases, 'anchored alias overlay');
  requireEqual(policy.local_discovery.effects, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, 'local discovery effects');
  if (expectedSource.sha256 === PINNED_SOURCE.sha256) validateProductionCensus(policy);
  return policy;
}

function validateProductionCensus(policy) {
  const rows = Object.values(policy.operations);
  for (const [status, count] of Object.entries({ admitted: 295, planned: 111, excluded: 109 })) requireEqual(rows.filter(row => row.status === status).length, count, `census ${status}`);
  requireEqual(Object.keys(policy.exclusion_groups).sort(), Object.keys(exclusionGroups).sort(), 'exclusion groups');
  for (const [group, expected] of Object.entries(exclusionGroups)) {
    requireEqual(policy.exclusion_groups[group].prefixes, expected.prefixes, `exclusion prefixes ${group}`);
    requireEqual(policy.exclusion_groups[group].count, expected.count, `exclusion count ${group}`);
    requireEqual(rows.filter(row => row.exclusion_group === group).length, expected.count, `exclusion rows ${group}`);
  }
  requireEqual(Object.entries(policy.operations).filter(([, row]) => row.status === 'admitted').map(([id]) => id).sort(), Object.keys(reviewedProfiles).sort(), 'exact admitted IDs');
  for (const [id, row] of Object.entries(policy.operations)) {
    for (const [key, value] of Object.entries(classify(id, row.path))) requireEqual(row[key], value, `classification ${id}.${key}`);
    if (Object.hasOwn(engineeringExclusions, id)) requireEqual(row.replacements, engineeringExclusions[id], `replacement workflow ${id}`);
  }
  for (const [milestone, families] of Object.entries(FAMILY_COUNTS)) {
    const actual = {};
    for (const row of rows.filter(row => row.milestone === Number(milestone))) actual[row.family] = (actual[row.family] ?? 0) + 1;
    requireEqual(actual, families, `milestone ${milestone} family census`);
  }
  const fileBindings = {
    dubbing_project_create: [{"field": "file", "kind": "audio", "max_bytes": 3221225472}, {"field": "transcript", "kind": "document", "allowed_media_types": ["application/json"], "max_bytes": 4194304}],
    add_voice: [{ field: 'files', kind: 'audio' }],
    edit_voice: [{ field: 'files', kind: 'audio' }],
    add_pvc_voice_samples: [{ field: 'files', kind: 'audio' }],
    request_pvc_manual_verification: [{ field: 'files', kind: ['image', 'document'] }],
    upload_song: [{ field: 'file', kind: 'audio' }],
    separate_song_stems: [{ field: 'file', kind: 'audio' }],
    create_finetune: [{ field: 'files', kind: 'audio' }],
    video_to_music: [{ field: 'videos', kind: 'audio', allowed_media_types: ['video/mp4', 'video/webm', 'video/quicktime'], max_total_bytes: 200_000_000 }],
    audio_isolation: [{ field: 'audio', kind: 'audio' }],
    speech_to_speech_full: [{ field: 'audio', kind: 'audio' }],
    speech_to_text: [{ field: 'file', kind: 'audio', max_bytes: 4_999_999_999 }],
    forced_alignment: [{ field: 'file', kind: 'audio', max_bytes: 999_999_999 }],
    get_similar_library_voices: [{ field: 'audio_file', kind: 'audio' }],
    add_from_file: [{ field: 'file', kind: 'document', allowed_media_types: ['application/pls+xml'] }],
    create_file_document_route: [{ field: 'file', kind: 'document' }],
    update_file_document_route: [{ field: 'file', kind: 'document' }],
    post_agent_avatar_route: [{ field: 'avatar_file', kind: 'image' }],
    post_agent_hold_audio_route: [{ field: 'hold_audio_file', kind: 'audio', allowed_media_types: ['audio/mpeg', 'audio/wav'], max_bytes: 40_000_000 }],
    upload_file_route: [{ field: 'file', kind: ['image', 'document'], allowed_media_types: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain', 'text/markdown', 'text/html', 'text/csv'] }],
  };
  for (const [id, row] of Object.entries(policy.operations)) {
    requireEqual(row.file_bindings, fileBindings[id], `reviewed file binding ${id}`);
    requireEqual(row.response_format_binding, [...stage91Profiles.run_job.split(' '), 'speech_to_speech_full', 'text_to_speech_full_with_timestamps', 'text_to_dialogue_full_with_timestamps', 'text_to_speech_stream_with_timestamps', 'text_to_dialogue_stream_with_timestamps'].includes(id) ? 'output_format' : undefined, `reviewed response format binding ${id}`);
  }
  requireEqual(policy.operations.create_file_document_route.timeout, 'long', 'create-file long timeout');
  requireEqual(policy.milestones, [{ number: 1, proposed_version: '0.6.0', version: null }, ...[7, 8, 9, 10].map(number => ({ number, version: null }))], 'unpublished milestones');
  requireEqual(policy.reserved_profiles.map(row => ({ profile: row.profile, tool: row.tool, milestone: row.milestone, effects: row.effects })), [
  ], 'unregistered reserved profiles');
}

export async function loadCoverageRosters(connectorRoot) {
  const ordinary = JSON.parse(await readFile(resolve(connectorRoot, 'test/fixtures/legacy-tools.json'), 'utf8'));
  const names = ordinary.map(tool => text.parse(tool.name));
  requireEqual(names.length, 32, 'captured legacy tool count');
  requireEqual(new Set(names).size, 32, 'unique captured legacy tools');
  if (ordinary.some(tool => !tool.description || !tool.inputSchema || !tool.annotations)) refuse('incomplete legacy capture', 'expected complete SDK definitions');
  const agentsRoot = resolve(connectorRoot, '../elevenlabs-agents');
  const smoke = await readFile(resolve(agentsRoot, 'test/smoke.test.ts'), 'utf8');
  const rosterText = smoke.match(/const EXPECTED_TOOL_NAMES = \[([\s\S]*?)\]\.sort\(\)/)?.[1];
  if (!rosterText) refuse('separate-package roster', 'missing smoke roster');
  const agents = [...rosterText.matchAll(/'([a-z_]+)'/g)].map(match => match[1]).sort();
  const registrations = [];
  for (const file of (await readdir(resolve(agentsRoot, 'src/tools'))).filter(file => file.endsWith('.ts')).sort()) {
    const source = await readFile(resolve(agentsRoot, 'src/tools', file), 'utf8');
    registrations.push(...[...source.matchAll(/server\.registerTool\(\s*'([a-z_]+)'/g)].map(match => match[1]));
  }
  requireEqual(agents.length, 31, 'separate-package smoke count');
  requireEqual(registrations.sort(), agents, 'separate-package actual registration roster');
  return { '@mindstone/mcp-server-elevenlabs': new Set(names), '@mindstone/mcp-server-elevenlabs-agents': new Set(agents) };
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);
function collectOperations(spec) {
  if (spec.openapi !== '3.1.0') refuse('OpenAPI dialect', String(spec.openapi));
  const operations = new Map();
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(item)) {
      if (!HTTP_METHODS.has(method)) continue;
      if (!operation.operationId) refuse('missing operation ID', `${method} ${path}`);
      if (operations.has(operation.operationId)) refuse('duplicate operation ID', operation.operationId);
      operations.set(operation.operationId, { method: method.toUpperCase(), path, operation, pathParameters: item.parameters ?? [] });
    }
  }
  return operations;
}

// Only schema-bearing positions recurse. A property named "format", or a $ref
// inside an example/default/enum value, is data and must survive unchanged.
const schemaMaps = new Set(['properties', 'patternProperties', '$defs', 'dependentSchemas']);
const schemaArrays = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const schemaSingles = new Set(['items', 'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems', 'contains', 'propertyNames', 'not', 'if', 'then', 'else', 'contentSchema']);
const standardKeywords = new Set([
  '$ref', '$schema', '$id', '$anchor', '$comment', 'type', 'title', 'description', 'default', 'examples', 'enum', 'const',
  'required', 'dependentRequired', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'pattern', 'format', 'minItems', 'maxItems', 'uniqueItems', 'minContains', 'maxContains',
  'minProperties', 'maxProperties', 'readOnly', 'writeOnly', 'deprecated', 'nullable', 'contentEncoding', 'contentMediaType',
  ...schemaMaps, ...schemaArrays, ...schemaSingles, ...SCHEMA_METADATA_KEYWORDS,
]);
function componentName(ref) {
  if (typeof ref !== 'string' || !/^#\/components\/schemas\/[^/]+$/.test(ref)) refuse('unsupported schema reference', String(ref));
  return ref.slice('#/components/schemas/'.length);
}
function componentSchema(spec, name) {
  const schemas = spec.components?.schemas;
  if (!schemas || !Object.hasOwn(schemas, name) || schemas[name] === undefined) refuse('missing component', name);
  return schemas[name];
}
function resolveSchema(schema, spec, visited = new Set()) {
  if (typeof schema !== 'object' || schema === null || !schema.$ref) return schema;
  const name = componentName(schema.$ref);
  if (visited.has(name)) refuse('cyclic root schema', name);
  visited.add(name);
  const target = componentSchema(spec, name);
  const { $ref, ...siblings } = schema;
  if (Object.keys(siblings).some(key => !['description', 'title', 'examples', 'default', ...SCHEMA_METADATA_KEYWORDS].includes(key))) refuse('constrained root reference', name);
  return { ...resolveSchema(target, spec, visited), ...siblings };
}
function scalarShape(schema, spec, allowArray, visited = new Set()) {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return false;
  if (schema.$ref) {
    const name = componentName(schema.$ref);
    if (visited.has(name)) return false;
    const next = new Set(visited); next.add(name);
    const { $ref, ...siblings } = schema;
    return scalarShape(componentSchema(spec, name), spec, allowArray, next)
      && (!Object.keys(siblings).some(key => ['type', 'anyOf', 'oneOf', 'allOf', 'items', 'properties'].includes(key)) || scalarShape(siblings, spec, allowArray, next));
  }
  if (schema.format === 'binary') return false;
  const compositions = ['anyOf', 'oneOf', 'allOf'].filter(key => schema[key]);
  if (compositions.length) return compositions.every(key => schema[key].every(child => scalarShape(child, spec, allowArray, new Set(visited))));
  if (schema.type === 'array') return allowArray && scalarShape(schema.items, spec, false, visited);
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  return types.every(type => ['string', 'number', 'integer', 'boolean', 'null'].includes(type));
}

function schemaCompiler(spec) {
  const defs = Object.create(null);
  function transform(schema, location, binary = false) {
    if (typeof schema === 'boolean') return schema;
    if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) refuse('invalid schema', location);
    if (Object.hasOwn(schema, 'unevaluatedProperties')) refuse('unsupported schema keyword unevaluatedProperties', `${location}; support requires a reviewed validator correction`);
    const output = {};
    for (const [key, value] of Object.entries(schema)) {
      if (!standardKeywords.has(key)) refuse('unknown schema keyword', `${location}: ${key}`);
      if (key === '$ref') {
        const name = componentName(value);
        if (!Object.hasOwn(defs, name)) {
          const component = componentSchema(spec, name);
          defs[name] = true;
          defs[name] = transform(component, `components/${name}`, binary);
        }
        output[key] = '#/$defs/' + name;
      } else if (key === 'format') {
        if (value === 'binary' ? !binary || schema.type !== 'string' : !SCHEMA_FORMATS.includes(value)) refuse(value === 'binary' ? 'binary in JSON position' : 'unknown schema format', `${location}: ${value}`);
        output[key] = value;
      } else if (schemaMaps.has(key)) {
        output[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, transform(child, `${location}/${key}/${name}`)]));
      } else if (schemaArrays.has(key)) {
        if (!Array.isArray(value)) refuse('invalid schema composition', `${location}/${key}`);
        output[key] = value.map((child, i) => transform(child, `${location}/${key}/${i}`, binary));
      } else if (schemaSingles.has(key)) {
        output[key] = transform(value, `${location}/${key}`, binary);
      } else if (key === 'discriminator' && value?.mapping) {
        output[key] = { ...value, mapping: Object.fromEntries(Object.entries(value.mapping).map(([name, ref]) => {
          const relocated = transform({ $ref: ref }, `${location}/discriminator/${name}`).$ref;
          return [name, relocated];
        })) };
      } else {
        output[key] = structuredClone(value);
      }
    }
    return output;
  }
  return { defs, transform };
}

function parameterRecords(parameters, spec, transform, id) {
  const records = { path: { type: 'object', properties: Object.create(null), required: [], additionalProperties: false }, query: { type: 'object', properties: Object.create(null), required: [], additionalProperties: false } };
  const serialization = Object.create(null);
  for (const parameter of parameters) {
    if (parameter.$ref) refuse('parameter reference', id);
    const { name, schema, required = false } = parameter;
    if (parameter.in === 'header' && name === 'xi-api-key') {
      transform(schema, `${id}/injected-header/${name}`);
      continue;
    }
    if (parameter.in === 'header') refuse('unsupported header parameter', `${id}: ${name}`);
    if (!['path', 'query'].includes(parameter.in)) refuse('unsupported parameter location', `${id}: ${parameter.in} ${name}`);
    if (!scalarShape(schema, spec, parameter.in === 'query')) refuse(parameter.in === 'query' ? 'non-scalar query' : 'non-scalar path', `${id}: ${name}`);
    if (parameter.content || parameter.allowReserved || (parameter.style && parameter.style !== (parameter.in === 'query' ? 'form' : 'simple')) || (parameter.in === 'query' && parameter.explode === false)) refuse('unsupported parameter serialization', `${id}: ${name}`);
    const record = records[parameter.in];
    if (Object.hasOwn(record.properties, name)) refuse('duplicate parameter', `${id}: ${parameter.in}.${name}`);
    if (parameter.in === 'path' && !required) refuse('optional path parameter', `${id}: ${name}`);
    record.properties[name] = transform(schema, `${id}/${parameter.in}/${name}`);
    if (required) record.required.push(name);
    if (parameter.in === 'query') serialization[name] = 'form-explode';
  }
  for (const record of Object.values(records)) record.required.sort();
  return { ...records, query_serialization: serialization };
}

function requestDescriptor(operation, row, spec, transform, id) {
  const body = operation.requestBody;
  if (!body) {
    if (row.file_bindings?.length) refuse('unbound binary field', id);
    return { media_type: null, required: false };
  }
  if (body.$ref) refuse('request body reference', id);
  const content = Object.entries(body.content ?? {});
  if (content.length !== 1) refuse('unsupported request media', `${id}: expected one JSON or multipart representation`);
  const [media, data] = content[0];
  if (media === 'application/json') {
    if (row.file_bindings?.length) refuse('mismatched binary binding', id);
    return { media_type: media, required: body.required === true, schema: transform(data.schema, `${id}/body`) };
  }
  if (media !== 'multipart/form-data') refuse('unsupported request media', `${id}: ${media}`);
  if (data.encoding) refuse('multipart encoding', id);
  const root = resolveSchema(data.schema, spec);
  if (root?.type !== 'object' || !root.properties || ['anyOf', 'oneOf', 'allOf', 'patternProperties', 'dependentSchemas', 'dependentRequired', 'if', 'then', 'else', 'not'].some(key => key in root)) refuse('non-scalar multipart', `${id}: expected an object of scalar fields and explicitly bound binary operands`);
  const scalar = structuredClone(root);
  const bindings = new Map((row.file_bindings ?? []).map(binding => [binding.field, binding]));
  if (bindings.size !== (row.file_bindings ?? []).length) refuse('duplicate binary binding', id);
  const files = [];
  const fields = {};
  for (const [field, schema] of Object.entries(root.properties)) {
    const resolved = resolveSchema(schema, spec);
    const shape = binaryFileShape(resolved, value => resolveSchema(value, spec));
    if (shape) {
      const binding = bindings.get(field);
      if (!binding) refuse('unbound or mismatched binary field', `${id}: ${field}`);
      files.push({ ...binding, required: (root.required ?? []).includes(field), schema: transform(resolved, `${id}/file/${field}`, true) });
      bindings.delete(field);
      delete scalar.properties[field];
      if (scalar.required) scalar.required = scalar.required.filter(name => name !== field);
    } else {
      if (bindings.has(field)) refuse('mismatched binary binding', `${id}: ${field}`);
      fields[field] = multipartFieldEncoding(schema, value => resolveSchema(value, spec));
    }
  }
  if (bindings.size) refuse('unbound binary field', `${id}: ${[...bindings.keys()].join(', ')}`);
  return { media_type: media, required: body.required === true, schema: transform(scalar, `${id}/multipart-fields`), fields, files: files.sort((a, b) => a.field < b.field ? -1 : 1) };
}

// Paths describe data operands, not schema syntax. * visits a declared map or array.
export function hasSensitivePath(schema, path, defs, seen = new Set()) {
  if (schema === null || typeof schema !== 'object') return false;
  if (!path.length) return true;
  if (schema.$ref && !seen.has(schema.$ref)) {
    const next = new Set(seen); next.add(schema.$ref);
    const name = schema.$ref.slice('#/$defs/'.length).replace(/~1/g, '/').replace(/~0/g, '~');
    if (hasSensitivePath(defs[name], path, defs, next)) return true;
  }
  if (['allOf', 'anyOf', 'oneOf'].some(key => (schema[key] ?? []).some(branch => hasSensitivePath(branch, path, defs, new Set(seen))))) return true;
  const [field, ...rest] = path;
  if (field === '*') return [schema.items, schema.additionalProperties].some(child => hasSensitivePath(child, rest, defs));
  return Object.hasOwn(schema.properties ?? {}, field) && hasSensitivePath(schema.properties[field], rest, defs);
}
// Derive credential operands wherever a request reaches them, not per operation.
export function credentialRequestPaths(schema, defs, path = [], seen = new Set(), component = '') {
  if (schema === null || typeof schema !== 'object') return [];
  if (schema.$ref) {
    if (seen.has(schema.$ref)) return [];
    const next = new Set(seen); next.add(schema.$ref);
    const name = schema.$ref.slice('#/$defs/'.length).replace(/~1/g, '/').replace(/~0/g, '~');
    return credentialRequestPaths(defs[name], defs, path, next, name);
  }
  const paths = [];
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    if (credentialIdentifiers.has(key)) continue;
    const operand = [...path, key];
    if (['request_headers', 'request_meta'].includes(key)) paths.push([...operand, '*']);
    else if (isCredentialKey(key)
      || (key === 'value' && /secret/i.test(component))) paths.push(operand);
    else paths.push(...credentialRequestPaths(child, defs, operand, new Set(seen), component));
  }
  for (const key of ['allOf', 'anyOf', 'oneOf']) for (const child of schema[key] ?? []) {
    paths.push(...credentialRequestPaths(child, defs, path, new Set(seen), component));
  }
  for (const child of [schema.items, schema.additionalProperties]) {
    if (child && typeof child === 'object') paths.push(...credentialRequestPaths(child, defs, [...path, '*'], new Set(seen), component));
  }
  return paths;
}

function checkSensitivePaths(paths, schemas, defs, id) {
  const unique = new Set();
  for (const path of paths ?? []) {
    const key = JSON.stringify(path);
    if (unique.has(key)) refuse('duplicate sensitive field', id);
    unique.add(key);
    if (!schemas.some(schema => hasSensitivePath(schema, path, defs))) refuse('unbound sensitive field', `${id}: ${path.join('.')}`);
  }
}

function successDescriptors(operation, transform, id, row) {
  const responses = [];
  for (const [status, response] of Object.entries(operation.responses ?? {}).sort()) {
    if (!/^2[0-9][0-9]$/.test(status)) continue;
    if (response.$ref) refuse('response reference', id);
    const headers = Object.keys(response.headers ?? {}).map(name => name.toLowerCase()).sort();
    const declaredHeaders = headers.length ? { headers } : {};
    const content = Object.entries(response.content ?? {});
    if (content.length === 0) responses.push({ status: Number(status), media_type: null, ...declaredHeaders });
    for (const [media, data] of content.sort()) {
      if ((media === 'multipart/mixed') !== Boolean(row.multipart) || (row.multipart && row.base64_audio)) refuse('invalid multipart strategy', id);
      const binary = media === 'audio/*' || Object.hasOwn(binaryExtensions, media);
      if (!binary && !['application/json', 'text/plain', 'text/html', 'multipart/mixed'].includes(media)) refuse('unsupported success media', `${id}: ${media}`);
      if (binary && data.schema !== undefined && (data.schema.type !== 'string' || data.schema.format !== 'binary' || Object.keys(data.schema).some(key => !['type', 'format'].includes(key)))) refuse('unsupported binary success schema', id);
      if (media === 'text/csv' && (data.schema?.type !== 'string' || data.schema?.format !== 'binary')) refuse('CSV requires a binary success schema', id);
      let output_formats;
      if (row.response_format_binding) {
        const schema = operation.parameters?.find(parameter => parameter.in === 'query' && parameter.name === row.response_format_binding)?.schema;
        if ((media !== 'audio/mpeg' && !row.base64_audio) || !schema?.enum?.length || !schema.enum.includes(schema.default) || schema.enum.some(format => !audioRepresentation(format))) refuse('invalid output-format binding', id);
        output_formats = { default: schema.default, values: schema.enum };
      }
      responses.push({ status: Number(status), media_type: media, ...declaredHeaders, ...(row.multipart ? { multipart: row.multipart } : {}), ...(row.base64_audio ? { base64_audio: row.base64_audio } : {}), ...(output_formats ? { output_formats } : {}), ...(data.schema !== undefined ? { schema: transform(data.schema, `${id}/response/${status}/${media}`, binary || Boolean(row.multipart)) } : {}) });
    }
  }
  if (responses.length === 0) refuse('missing concrete success response', id);
  return responses;
}
function paginationDescriptor(operation, parameters, responses, spec, id, row) {
  const queries = parameters.filter(parameter => parameter.in === 'query').map(parameter => parameter.name);
  function rootProperties(schema, seen = new Set()) {
    if (schema === null || typeof schema !== 'object') return [];
    const names = Object.keys(schema.properties ?? {});
    if (schema.$ref) {
      const name = componentName(schema.$ref);
      if (!seen.has(name)) {
        const next = new Set(seen); next.add(name);
        names.push(...rootProperties(componentSchema(spec, name), next));
      }
    }
    for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
      for (const branch of schema[keyword] ?? []) names.push(...rootProperties(branch, new Set(seen)));
    }
    return names;
  }
  const properties = responses.flatMap(response => {
    const schema = operation.responses[String(response.status)]?.content?.[response.media_type]?.schema;
    return rootProperties(schema);
  });
  const unsupported = new Set(['offset', 'skip', 'limit', 'page', 'page_number', 'page_index', 'page_token', 'page_key', 'page_cursor',
    'next_page_token', 'start_after', 'start_after_history_item_id', 'last_doc', 'next_doc', 'next_page', 'next_token',
    'after', 'before', 'starting_after', 'ending_before', 'continuation', 'continuation_token', 'continuationToken', 'pagination', 'paging']);
  if (row.manual_pagination !== undefined) {
    const documents = queries.includes('last_doc') && properties.includes('next_doc') && properties.includes('has_more');
    const tokens = queries.includes('next_page_token') && properties.includes('next_page_token') && properties.includes('has_more');
    if (row.method !== 'GET' || row.profile !== 'read' || (!documents && !tokens && !queries.some(name => ['limit', 'page'].includes(name)))
      || queries.includes('cursor') || properties.includes('next_cursor')
      || [...queries, ...properties].some(name => unsupported.has(name) && !['limit', 'page', ...(documents ? ['last_doc', 'next_doc'] : []), ...(tokens ? ['next_page_token'] : [])].includes(name))) refuse('invalid manual pagination', id);
    return null;
  }
  if ([...queries, ...properties].some(name => unsupported.has(name))) refuse('unsupported pagination', `${id}: only cursor -> next_cursor is supported`);
  if (queries.includes('cursor') !== properties.includes('next_cursor')) refuse('unsupported pagination', `${id}: expected cursor -> next_cursor pair`);
  return queries.includes('cursor') ? { request: 'cursor', response: 'next_cursor' } : null;
}

// Every caller supplies its own explicit pin. The CLI always uses PINNED_SOURCE;
// miniature fixtures never weaken or replace that production pin.
export function compileCatalog(input, rawPolicy, expectedSource, rosters) {
  const bytes = verifySource(input, expectedSource);
  const policy = validatePolicy(rawPolicy, rosters, expectedSource);
  const spec = JSON.parse(bytes.toString('utf8'));
  requireEqual(Object.keys(spec.paths ?? {}).length, expectedSource.paths, 'source path count');
  const operations = collectOperations(spec);
  requireEqual([...operations.keys()].sort(), Object.keys(policy.operations).sort(), 'exact spec/policy operation ID set');
  for (const [id, { method, path }] of operations) {
    requireEqual({ method: policy.operations[id].method, path: policy.operations[id].path }, { method, path }, `policy/spec route ${id}`);
  }
  const { defs, transform } = schemaCompiler(spec);
  const descriptors = [];
  for (const [id, row] of Object.entries(policy.operations).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (row.status !== 'admitted') continue;
    const { operation, pathParameters } = operations.get(id);
    const parameters = [...pathParameters, ...(operation.parameters ?? [])];
    const records = parameterRecords(parameters, spec, transform, id);
    const placeholders = [...row.path.matchAll(/\{([^}]+)\}/g)].map(match => match[1]).sort();
    requireEqual(Object.keys(records.path.properties).sort(), placeholders, `path operand bindings ${id}`);
    const request = requestDescriptor(operation, row, spec, transform, id);
    const responses = successDescriptors(operation, transform, id, row);
    if (row.base64_audio) for (const response of responses) {
      const binding = row.base64_audio;
      if (response.media_type !== 'application/json' || !hasSensitivePath(response.schema, binding.array ? [binding.array, '*', binding.field] : [binding.field], defs)) refuse('unbound base64 audio', id);
    }
    checkSensitivePaths(row.sensitive_request_fields, [request.schema], defs, id);
    checkSensitivePaths(row.sensitive_response_fields, responses.map(response => response.schema), defs, id);
    if (row.credential_return_fields?.some(path => !path.length) && !responses.some(response => response.schema?.type === 'string' && ['text/plain', 'text/html'].includes(response.media_type))) refuse('whole credential return requires scalar text', id);
    checkSensitivePaths(row.credential_return_fields, responses.map(response => response.schema), defs, id);
    for (const returned of row.credential_return_fields ?? []) {
      if ((row.sensitive_response_fields ?? []).some(hidden => hidden.length === returned.length && hidden.every((part, i) => part === returned[i] || part === '*' || returned[i] === '*'))) refuse('overlapping credential return and sensitive response field', id);
    }
    const sensitiveRequests = [...new Map([...(row.sensitive_request_fields ?? []), ...credentialRequestPaths(request.schema, defs)].map(path => [JSON.stringify(path), path])).values()];
    descriptors.push({
      operation_id: id, method: row.method, path: row.path, family: row.family, milestone: row.milestone,
      profile: row.profile, tool: PROFILE_TOOLS[row.profile], effects: row.effects, effect_reason: row.effect_reason,
      check_before_retry: policy.family_retry_checks[row.family][row.profile === 'tests' ? 'tests' : 'read'],
      ...(row.reviewed_post_read ? { reviewed_post_read: row.reviewed_post_read } : {}),
      ...(row.reviewed_get_create ? { reviewed_get_create: row.reviewed_get_create } : {}),
      ...(row.credential_return_fields ? { credential_return_fields: row.credential_return_fields } : {}),
      ...(row.reviewed_patch_delete ? { reviewed_patch_delete: row.reviewed_patch_delete } : {}),
      ...(sensitiveRequests.length ? { sensitive_request_fields: sensitiveRequests } : {}),
      ...(row.sensitive_response_fields ? { sensitive_response_fields: row.sensitive_response_fields } : {}),
      ...(row.effect_note ? { effect_note: row.effect_note } : {}),
      ...(row.manual_pagination ? { manual_pagination: row.manual_pagination } : {}),
      summary: row.discovery_summary ?? operation.summary ?? id, description: operation.description ?? '', deprecated: operation.deprecated === true,
      parameters: records, request, responses,
      pagination: paginationDescriptor(operation, parameters, responses, spec, id, row),
      timeout: row.timeout ?? 'standard', authentication: { header: 'xi-api-key', supplied_by: 'connector' },
      search_aliases: row.search_aliases ?? [], rank: row.rank ?? 0, follow_ups: row.follow_ups ?? [], examples: row.examples ?? [],
    });
  }
  return sortKeys({ source: policy.source, compatibility_overlay: policy.compatibility_overlay,
    schema_metadata_keywords: SCHEMA_METADATA_KEYWORDS, schema_formats: SCHEMA_FORMATS,
    validator_options: VALIDATOR_OPTIONS, operations: descriptors, $defs: defs });
}

export function renderCatalog(catalog) {
  // JSON parsing preserves own __proto__ keys that object literals turn into prototypes.
  return '// Generated by scripts/generate-api-catalog.mjs; do not edit.\n'
    + '// Only admitted operations and their reachable provider schemas are included.\n'
    + 'export const apiCatalog: unknown = JSON.parse(' + JSON.stringify(stableJson(catalog).trimEnd()) + ');\n';
}
export function renderMetadata(catalog) {
  const aliases = { 'knowledge-base': 'knowledge', 'agent-testing': 'tests', 'test-invocations': 'tests', llm: 'agents', agent: 'agents' };
  const families = Object.fromEntries([...new Set(catalog.operations.map(op => op.family))].sort().map(name => [name, aliases[name] ?? name]));
  const discoveryFamilies = [...new Set(['agents', 'tools', 'knowledge', 'tests', ...Object.values(families)])];
  const profileOperationIds = Object.fromEntries(Object.keys(PROFILE_TOOLS).map(profile => [profile, catalog.operations.filter(op => op.profile === profile).map(op => op.operation_id).sort()]));
  return '// Generated by scripts/generate-api-catalog.mjs; do not edit.\n'
    + `export const apiFamilies = ${JSON.stringify(families, null, 2)} as const;\n`
    + `export const discoveryFamilies = ${JSON.stringify(discoveryFamilies)} as const;\n`
    + `export const profileOperationIds = ${JSON.stringify(profileOperationIds, null, 2)} as const;\n`;
}
function cell(value) { return String(value).replaceAll('|', '\\|').replaceAll('\n', ' '); }
export function renderCoverage(rawPolicy, rosters) {
  const policy = validatePolicy(rawPolicy, rosters);
  const rows = Object.entries(policy.operations).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const counts = Object.fromEntries(['admitted', 'planned', 'excluded'].map(status => [status, rows.filter(([, row]) => row.status === status).length]));
  const lines = [
    '# ElevenLabs API coverage', '',
    'Generated from the explicit operation policy. Admission describes the new API interface; existing coverage is an independent assessment of the unchanged ordinary and Agents packages.', '',
    `Source: ${policy.source.url}`, `Retrieved: ${policy.source.retrieved_at}`, `SHA-256 (original decompressed bytes): \`${policy.source.sha256}\``,
    `Source census: ${policy.source.paths} paths; ${policy.source.operations} HTTP operation IDs; ${policy.source.bytes.toLocaleString('en-US')} bytes.`, '',
    `Partition: **${counts.admitted} admitted + ${counts.planned} planned + ${counts.excluded} excluded = ${rows.length}**.`, '',
    'Numeric milestones: 1 (40), 7 (134), 8 (35), 9 (131), 10 (66). The first 40 shipped in 0.6.0; the ledger below records all operations admitted by this source tree. Consult the package changelog for release history.', '',
    `Only admitted descriptors and their reachable component graph enter the generated catalogue. Nine registered API tools expose local discovery and eight execution profiles for the ${counts.admitted} admitted operations, alongside the unchanged ordinary 32 definitions (41 total). The separate Agents package is unchanged.`, '',
    'Public consistency tests validate the committed policy, catalogue, ledger and explicitly pinned miniature fixtures. Public CI does **not** possess or validate the whole upstream snapshot. Full-source generation and --check require an explicit local JSON or gzip input matching the pinned original bytes; the whole source is neither committed nor included in npm. No runtime fetch occurs.', '',
    'Regenerate from the connector directory: `npm run api:generate -- --spec <pinned.json-or-gzip>`. Verify with `npm run api:check -- --spec <pinned.json-or-gzip>`. Both commands verify the immutable production source pin.', '',
    'Provider constraints (including enums, required fields, maps and open objects) are preserved. Only synthesized path/query records are closed. Forbidden aliases are exact anchored own-property checks described in the compatibility overlay, separate from discovery search aliases. Enum errors refer to the 2026-11-08 snapshot and recommend a reviewed catalogue refresh.', '',
    'File uploads bind only reviewed multipart fields and image, audio or document kinds. Avatar images use PNG, JPEG, GIF or WebP with the runtime buffer limit; the spec gives no avatar size limit. Hold audio accepts MP3 or WAV up to 40 MB; the provider also limits duration to 180 seconds. Conversation uploads accept images, PDFs or text and return a file ID for use in the conversation, not an audio attachment. File requiredness is separate from scalar multipart fields; create-file uses the existing long request timeout category. Document uploads use document MIME types with application/octet-stream fallback, regular-file and descriptor identity checks, and the runtime buffer size limit. Provider format and account limits still apply. The legacy audio MIME fallback is unchanged.', '',
    'Saved Tests can spend credits and invoke real integrations. No implicit mocks, retries, polling, attachment merges or cleanup are authorized. Knowledge retrieval can spend credits but creates no conversation. Host permission bands determine authority; these annotations are not a host rating.', '',
    'Ajv and ajv-formats are direct dependencies so the validator interprets the retained schema graph directly with strict, non-mutating validation and full standard formats; zoneinfo uses Intl. They are existing locked dependencies promoted to direct dependencies, not a claim that Zod cannot represent unions or recursion.', '',
    '## Exclusions', '',
    ...Object.entries(policy.exclusion_groups).sort().map(([name, group]) => `- ${name}: ${group.count}. ${group.reason}`), '',
    'Deprecated upload replacement: create a file **or URL** document, preserving optional name; optional attachment requires get_agent_route followed by an explicit caller-authored patch_agent_settings_route with existing structured locators plus the new locator. The document response model is the same; inputs and atomic behavior differ. No automatic read/merge/write or cleanup is implied.', '',
    '## Exact operation ledger', '',
    '| Operation ID | Method | Path | Status | Milestone | Family | Profile | Existing coverage | Existing package:tool references | Reason / replacements |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const [id, row] of rows) {
    const reason = [...new Set([row.reason, row.existing_coverage.reason, row.replacements.length ? 'Replacement IDs: ' + row.replacements.join(', ') : ''].filter(Boolean))].join(' ');
    lines.push('| ' + [id, row.method, row.path, row.status, row.milestone ?? '—', row.family, row.profile ?? '—', row.existing_coverage.status, row.existing_coverage.tools.join(', ') || '—', reason].map(cell).join(' | ') + ' |');
  }
  return lines.join('\n') + '\n';
}

export async function generateArtifacts(connectorRoot, specPath, check = false) {
  const policy = JSON.parse(await readFile(resolve(connectorRoot, 'api/operation-policy.json'), 'utf8'));
  const rosters = await loadCoverageRosters(connectorRoot);
  const catalog = compileCatalog(await readFile(specPath), policy, PINNED_SOURCE, rosters);
  const outputs = new Map([
    ['src/generated/api-catalog.ts', renderCatalog(catalog)],
    ['src/generated/api-metadata.ts', renderMetadata(catalog)],
    ['API_COVERAGE.md', renderCoverage(policy, rosters)],
  ]);
  for (const [relativePath, content] of outputs) {
    const path = resolve(connectorRoot, relativePath);
    if (check) {
      const existing = await readFile(path, 'utf8');
      if (existing !== content) refuse('generated artifact drift', relativePath);
    } else {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    }
  }
  return { operations: catalog.operations.length, components: Object.keys(catalog.$defs).length, checked: check };
}
async function main(args) {
  let specPath; let check = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--spec' && args[index + 1] && !specPath) specPath = args[++index];
    else if (args[index] === '--check' && !check) check = true;
    else refuse('CLI arguments', 'Usage: node scripts/generate-api-catalog.mjs --spec <JSON-or-gzip> [--check]');
  }
  if (!specPath) refuse('missing pinned input', 'Pass --spec <JSON-or-gzip>; this generator never fetches upstream');
  const connectorRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  console.log(JSON.stringify(await generateArtifacts(connectorRoot, resolve(specPath), check)));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
