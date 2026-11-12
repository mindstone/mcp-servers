// Literal expectations transcribed from the 2026-11-08 provider snapshot, not the generated catalogue.
// All 40 expectations are literal; multipart cases carry their own file bytes and receipts.
export type WireProfile = 'read' | 'create' | 'change' | 'delete' | 'tests' | 'query_knowledge';
export interface WireCase {
  id: string;
  profile: WireProfile;
  args: Record<string, unknown>;
  method: string;
  path: string;
  query: [string, string][];
  body?: unknown;
  status: number;
  media: 'application/json' | 'text/html' | null;
  response: unknown;
}

const access = { is_creator: true, creator_name: 'Jane Example', creator_email: 'jane@example.com', role: 'admin' };
const agent = { agent_id: 'agent_example', name: 'Acme guide', conversation_config: {}, metadata: { created_at_unix_secs: 1, updated_at_unix_secs: 2 } };
const tool = { id: 'tool_example', tool_config: { type: 'client', name: 'lookup_guide', description: 'Find a guide entry.' }, access_info: access, usage_stats: { avg_latency_secs: 0 } };
const document = { id: 'doc_example', name: 'Guide', type: 'text', metadata: { created_at_unix_secs: 1, last_updated_at_unix_secs: 2, size_bytes: 20 }, supported_usages: [], access_info: access, extracted_inner_html: '<p>Acme guide</p>' };
const urlDocument = { ...document, type: 'url', url: 'https://docs.example.com/guide' };
const test = { id: 'test_example', name: 'Guide mock test', type: 'simulation' };
const invocation = { id: 'invocation_example', test_runs: [] };

export const apiWireCases: WireCase[] = [
  {
    id: 'get_agents_route', profile: 'read', args: { query_params: { search: 'Acme & guide', page_size: 2, archived: false, tags: ['help desk', 'a&b'], cursor: null } },
    method: 'GET', path: '/v1/convai/agents', query: [['search', 'Acme & guide'], ['page_size', '2'], ['archived', 'false'], ['tags', 'help desk'], ['tags', 'a&b']],
    status: 200, media: 'application/json', response: { agents: [], has_more: true, next_cursor: 'page & 2' },
  },
  {
    id: 'get_agent_route', profile: 'read', args: { path_params: { agent_id: 'agent/a ?#' }, query_params: { version_id: 'version & 1', branch_id: null, include_procedure_generated_workflow_elements: false } },
    method: 'GET', path: '/v1/convai/agents/agent%2Fa%20%3F%23', query: [['version_id', 'version & 1'], ['include_procedure_generated_workflow_elements', 'false']],
    status: 200, media: 'application/json', response: agent,
  },
  {
    id: 'list_available_llms', profile: 'read', args: {}, method: 'GET', path: '/v1/convai/llm/list', query: [],
    status: 200, media: 'application/json', response: { llms: [], default_deprecation_config: { warning_start_days: 30, fallback_start_days: 14, fallback_complete_days: 1, fallback_start_percentage: 10, fallback_complete_percentage: 100 } },
  },
  {
    id: 'get_tools_route', profile: 'read', args: { query_params: { search: 'lookup_', types: ['client', 'webhook'], show_only_owned_documents: true, page_size: 2 } },
    method: 'GET', path: '/v1/convai/tools', query: [['search', 'lookup_'], ['types', 'client'], ['types', 'webhook'], ['show_only_owned_documents', 'true'], ['page_size', '2']],
    status: 200, media: 'application/json', response: { tools: [], has_more: false, next_cursor: null },
  },
  {
    id: 'get_tool_route', profile: 'read', args: { path_params: { tool_id: 'tool/a ?#' }, query_params: { environment: 'staging & demo' } },
    method: 'GET', path: '/v1/convai/tools/tool%2Fa%20%3F%23', query: [['environment', 'staging & demo']], status: 200, media: 'application/json', response: tool,
  },
  {
    id: 'get_tool_dependent_agents_route', profile: 'read', args: { path_params: { tool_id: 'tool/a ?#' }, query_params: { cursor: 'page & 2', page_size: 2 } },
    method: 'GET', path: '/v1/convai/tools/tool%2Fa%20%3F%23/dependent-agents', query: [['cursor', 'page & 2'], ['page_size', '2']],
    status: 200, media: 'application/json', response: { agents: [], has_more: false },
  },
  {
    id: 'get_knowledge_base_list_route', profile: 'read', args: { query_params: { search: 'Guide', types: ['text', 'url'], folders_first: true, page_size: 2 } },
    method: 'GET', path: '/v1/convai/knowledge-base', query: [['search', 'Guide'], ['types', 'text'], ['types', 'url'], ['folders_first', 'true'], ['page_size', '2']],
    status: 200, media: 'application/json', response: { documents: [], has_more: false },
  },
  {
    id: 'get_documentation_from_knowledge_base', profile: 'read', args: { path_params: { documentation_id: 'doc/a ?#' }, query_params: { agent_id: 'agent & 1' } },
    method: 'GET', path: '/v1/convai/knowledge-base/doc%2Fa%20%3F%23', query: [['agent_id', 'agent & 1']], status: 200, media: 'application/json', response: document,
  },
  {
    id: 'get_knowledge_base_content', profile: 'read', args: { path_params: { documentation_id: 'doc/a ?#' } },
    method: 'GET', path: '/v1/convai/knowledge-base/doc%2Fa%20%3F%23/content', query: [], status: 200, media: 'text/html', response: '<h1>Acme guide</h1>',
  },
  {
    id: 'get_documentation_chunks_from_knowledge_base', profile: 'read', args: { path_params: { documentation_id: 'doc/a ?#' }, query_params: { embedding_model: 'e5_mistral_7b_instruct', page_size: 2, cursor: 'chunk & 2' } },
    method: 'GET', path: '/v1/convai/knowledge-base/doc%2Fa%20%3F%23/chunks', query: [['embedding_model', 'e5_mistral_7b_instruct'], ['page_size', '2'], ['cursor', 'chunk & 2']],
    status: 200, media: 'application/json', response: { chunks: [], next_cursor: null },
  },
  {
    id: 'search_knowledge_base_content_route', profile: 'read', args: { query_params: { query: 'opening & hours', types: ['text', 'url'], page_size: 2 } },
    method: 'GET', path: '/v1/convai/knowledge-base/search', query: [['query', 'opening & hours'], ['types', 'text'], ['types', 'url'], ['page_size', '2']],
    status: 200, media: 'application/json', response: { results: [], next_cursor: 'search & 2' },
  },
  {
    id: 'get_knowledge_base_dependent_agents', profile: 'read', args: { path_params: { documentation_id: 'doc/a ?#' }, query_params: { dependent_type: 'all', page_size: 2 } },
    method: 'GET', path: '/v1/convai/knowledge-base/doc%2Fa%20%3F%23/dependent-agents', query: [['dependent_type', 'all'], ['page_size', '2']],
    status: 200, media: 'application/json', response: { agents: [], has_more: false },
  },
  {
    id: 'get_rag_indexes', profile: 'read', args: { path_params: { documentation_id: 'doc/a ?#' } }, method: 'GET', path: '/v1/convai/knowledge-base/doc%2Fa%20%3F%23/rag-index', query: [],
    status: 200, media: 'application/json', response: { indexes: [] },
  },
  {
    id: 'get_agent_response_test_route', profile: 'read', args: { path_params: { test_id: 'test/a ?#' } }, method: 'GET', path: '/v1/convai/agent-testing/test%2Fa%20%3F%23', query: [],
    status: 200, media: 'application/json', response: test,
  },
  {
    id: 'list_chat_response_tests_route', profile: 'read', args: { query_params: { types: ['simulation', 'folder'], include_folders: false, search: 'Guide', page_size: 2 } },
    method: 'GET', path: '/v1/convai/agent-testing', query: [['types', 'simulation'], ['types', 'folder'], ['include_folders', 'false'], ['search', 'Guide'], ['page_size', '2']],
    status: 200, media: 'application/json', response: { tests: [], has_more: false },
  },
  {
    id: 'list_test_invocations_route', profile: 'read', args: { query_params: { agent_id: 'agent & 1', start_time: 100, end_time: 200, cursor: null, page_size: 2 } },
    method: 'GET', path: '/v1/convai/test-invocations', query: [['agent_id', 'agent & 1'], ['start_time', '100'], ['end_time', '200'], ['page_size', '2']],
    status: 200, media: 'application/json', response: { results: [], has_more: false },
  },
  {
    id: 'get_test_invocation_route', profile: 'read', args: { path_params: { test_invocation_id: 'inv/a ?#' } }, method: 'GET', path: '/v1/convai/test-invocations/inv%2Fa%20%3F%23', query: [],
    status: 200, media: 'application/json', response: invocation,
  },
  {
    id: 'create_agent_route', profile: 'create', args: { query_params: { enable_versioning: false }, body: { name: 'Acme guide', conversation_config: { agent: { prompt: { llm: 'gemini-3.5-flash', prompt: 'Use the guide.', knowledge_base: [{ type: 'file', name: 'Guide', id: 'doc_example' }] } }, tts: { voice_id: 'voice_example' } } } },
    method: 'POST', path: '/v1/convai/agents/create', query: [['enable_versioning', 'false']],
    body: { name: 'Acme guide', conversation_config: { agent: { prompt: { llm: 'gemini-3.5-flash', prompt: 'Use the guide.', knowledge_base: [{ type: 'file', name: 'Guide', id: 'doc_example' }] } }, tts: { voice_id: 'voice_example' } } },
    status: 200, media: 'application/json', response: { agent_id: 'agent_example' },
  },
  {
    id: 'duplicate_agent_route', profile: 'create', args: { path_params: { agent_id: 'agent/a ?#' }, body: { name: 'Guide copy' } },
    method: 'POST', path: '/v1/convai/agents/agent%2Fa%20%3F%23/duplicate', query: [], body: { name: 'Guide copy' }, status: 200, media: 'application/json', response: { agent_id: 'agent_copy' },
  },
  {
    id: 'add_tool_route', profile: 'create', args: { body: { tool_config: { type: 'webhook', name: 'lookup_guide', description: 'Find guide entries.', api_schema: { url: 'https://api.example.com/guide', method: 'POST' } }, response_mocks: [{ mock_result: '{"entries":[]}', parameter_conditions: [], is_error: false }] } },
    method: 'POST', path: '/v1/convai/tools', query: [], body: { tool_config: { type: 'webhook', name: 'lookup_guide', description: 'Find guide entries.', api_schema: { url: 'https://api.example.com/guide', method: 'POST' } }, response_mocks: [{ mock_result: '{"entries":[]}', parameter_conditions: [], is_error: false }] },
    status: 200, media: 'application/json', response: tool,
  },
  {
    id: 'create_text_document_route', profile: 'create', args: { body: { text: 'Acme guide text', name: 'Guide', parent_folder_id: null } },
    method: 'POST', path: '/v1/convai/knowledge-base/text', query: [], body: { text: 'Acme guide text', name: 'Guide', parent_folder_id: null }, status: 200, media: 'application/json', response: { id: 'doc_example', name: 'Guide' },
  },
  {
    id: 'create_url_document_route', profile: 'create', args: { body: { url: 'https://docs.example.com/guide?a=1&b=2', name: 'Guide', enable_auto_sync: false } },
    method: 'POST', path: '/v1/convai/knowledge-base/url', query: [], body: { url: 'https://docs.example.com/guide?a=1&b=2', name: 'Guide', enable_auto_sync: false }, status: 200, media: 'application/json', response: { id: 'doc_example', name: 'Guide' },
  },
  {
    id: 'create_folder_route', profile: 'create', args: { body: { name: 'Guides', parent_folder_id: 'parent_example' } },
    method: 'POST', path: '/v1/convai/knowledge-base/folder', query: [], body: { name: 'Guides', parent_folder_id: 'parent_example' }, status: 200, media: 'application/json', response: { id: 'folder_example', name: 'Guides' },
  },
  {
    id: 'rag_index_status', profile: 'create', args: { path_params: { documentation_id: 'doc/a ?#' }, body: { model: 'e5_mistral_7b_instruct' } },
    method: 'POST', path: '/v1/convai/knowledge-base/doc%2Fa%20%3F%23/rag-index', query: [], body: { model: 'e5_mistral_7b_instruct' },
    status: 200, media: 'application/json', response: { id: 'index_example', model: 'e5_mistral_7b_instruct', status: 'processing', progress_percentage: 10, document_model_index_usage: { used_bytes: 20 } },
  },
  {
    id: 'create_agent_response_test_route', profile: 'create', args: { body: { type: 'simulation', name: 'Guide mock test', simulation_scenario: 'Ask about the guide.', tool_mock_config: { mocking_strategy: 'all', fallback_strategy: 'raise_error' }, tool_mock_overrides: {} } },
    method: 'POST', path: '/v1/convai/agent-testing/create', query: [], body: { type: 'simulation', name: 'Guide mock test', simulation_scenario: 'Ask about the guide.', tool_mock_config: { mocking_strategy: 'all', fallback_strategy: 'raise_error' }, tool_mock_overrides: {} },
    status: 200, media: 'application/json', response: { id: 'test_example' },
  },
  {
    id: 'patch_agent_settings_route', profile: 'change', args: { path_params: { agent_id: 'agent/a ?#' }, query_params: { branch_id: 'branch & 1' }, body: { conversation_config: { agent: { first_message: 'Welcome.' } } } },
    method: 'PATCH', path: '/v1/convai/agents/agent%2Fa%20%3F%23', query: [['branch_id', 'branch & 1']], body: { conversation_config: { agent: { first_message: 'Welcome.' } } }, status: 200, media: 'application/json', response: agent,
  },
  {
    id: 'update_tool_route', profile: 'change', args: { path_params: { tool_id: 'tool/a ?#' }, body: { tool_config: { type: 'client', name: 'lookup_guide', description: 'Find guide entries.', expects_response: true } } },
    method: 'PATCH', path: '/v1/convai/tools/tool%2Fa%20%3F%23', query: [], body: { tool_config: { type: 'client', name: 'lookup_guide', description: 'Find guide entries.', expects_response: true } }, status: 200, media: 'application/json', response: tool,
  },
  {
    id: 'update_document_route', profile: 'change', args: { path_params: { documentation_id: 'doc/a ?#' }, body: { name: 'Revised guide', content: 'New guide text', auto_remove: null } },
    method: 'PATCH', path: '/v1/convai/knowledge-base/doc%2Fa%20%3F%23', query: [], body: { name: 'Revised guide', content: 'New guide text', auto_remove: null }, status: 200, media: 'application/json', response: document,
  },
  {
    id: 'refresh_url_document_route', profile: 'change', args: { path_params: { documentation_id: 'doc/a ?#' } },
    method: 'POST', path: '/v1/convai/knowledge-base/doc%2Fa%20%3F%23/refresh', query: [], status: 200, media: 'application/json', response: urlDocument,
  },
  {
    id: 'update_agent_response_test_route', profile: 'change', args: { path_params: { test_id: 'test/a ?#' }, body: { type: 'simulation', name: 'Revised mock test', tool_mock_config: { mocking_strategy: 'all', fallback_strategy: 'raise_error' }, tool_mock_overrides: {} } },
    method: 'PUT', path: '/v1/convai/agent-testing/test%2Fa%20%3F%23', query: [], body: { type: 'simulation', name: 'Revised mock test', tool_mock_config: { mocking_strategy: 'all', fallback_strategy: 'raise_error' }, tool_mock_overrides: {} }, status: 200, media: 'application/json', response: test,
  },
  {
    id: 'delete_agent_route', profile: 'delete', args: { path_params: { agent_id: 'agent/a ?#' }, query_params: { force: false } },
    method: 'DELETE', path: '/v1/convai/agents/agent%2Fa%20%3F%23', query: [['force', 'false']], status: 204, media: null, response: null,
  },
  {
    id: 'delete_tool_route', profile: 'delete', args: { path_params: { tool_id: 'tool/a ?#' }, query_params: { force: false } },
    method: 'DELETE', path: '/v1/convai/tools/tool%2Fa%20%3F%23', query: [['force', 'false']], status: 200, media: 'application/json', response: {},
  },
  {
    id: 'delete_knowledge_base_document', profile: 'delete', args: { path_params: { documentation_id: 'doc/a ?#' }, query_params: { force: false } },
    method: 'DELETE', path: '/v1/convai/knowledge-base/doc%2Fa%20%3F%23', query: [['force', 'false']], status: 200, media: 'application/json', response: {},
  },
  {
    id: 'delete_chat_response_test_route', profile: 'delete', args: { path_params: { test_id: 'test/a ?#' } },
    method: 'DELETE', path: '/v1/convai/agent-testing/test%2Fa%20%3F%23', query: [], status: 200, media: 'application/json', response: {},
  },
  {
    id: 'run_agent_test_suite_route', profile: 'tests', args: { path_params: { agent_id: 'agent/a ?#' }, body: { tests: [{ test_id: 'test_example' }], repeat_count: 1, agent_config_override: { conversation_config: { agent: { first_message: 'Hello.' } }, platform_settings: {} } } },
    method: 'POST', path: '/v1/convai/agents/agent%2Fa%20%3F%23/run-tests', query: [], body: { tests: [{ test_id: 'test_example' }], repeat_count: 1, agent_config_override: { conversation_config: { agent: { first_message: 'Hello.' } }, platform_settings: {} } }, status: 200, media: 'application/json', response: invocation,
  },
  {
    id: 'cancel_test_invocation_route', profile: 'tests', args: { path_params: { test_invocation_id: 'inv/a ?#' } },
    method: 'POST', path: '/v1/convai/test-invocations/inv%2Fa%20%3F%23/cancel', query: [], status: 204, media: null, response: null,
  },
  {
    id: 'resubmit_tests_route', profile: 'tests', args: { path_params: { test_invocation_id: 'inv/a ?#' }, body: { agent_id: 'agent_example', test_run_ids: ['run_example'], agent_config_override: null } },
    method: 'POST', path: '/v1/convai/test-invocations/inv%2Fa%20%3F%23/resubmit', query: [], body: { agent_id: 'agent_example', test_run_ids: ['run_example'], agent_config_override: null }, status: 200, media: 'application/json', response: {},
  },
  {
    id: 'query_agent_knowledge_base_rag_route', profile: 'query_knowledge', args: { path_params: { agent_id: 'agent/a ?#' }, query_params: { branch_id: 'branch & 1' }, body: { strategy: 'semantic', query: 'opening hours', documents: ['doc_example'], use_agent_defaults: false } },
    method: 'POST', path: '/v1/convai/agents/agent%2Fa%20%3F%23/knowledge-base/rag-query', query: [['branch_id', 'branch & 1']], body: { strategy: 'semantic', query: 'opening hours', documents: ['doc_example'], use_agent_defaults: false },
    status: 200, media: 'application/json', response: { strategy: 'semantic', retrieval_query: 'opening hours', chunks: [] },
  },
];

export interface MultipartWireCase extends WireCase {
  multipart: { scalars: [string, string][]; field: string; fileName: string; mime: string; bytes: number[] };
}
export const multipartCases: MultipartWireCase[] = [
  {
    id: 'create_file_document_route', profile: 'create',
    args: { body: { name: 'Acme guide', parent_folder_id: 'folder & 1' }, files: [{ field: 'file', file_path: './guide.pdf' }] },
    method: 'POST', path: '/v1/convai/knowledge-base/file', query: [],
    multipart: { scalars: [['name', 'Acme guide'], ['parent_folder_id', 'folder & 1']], field: 'file', fileName: 'guide.pdf', mime: 'application/pdf', bytes: [37, 80, 68, 70, 45, 49, 46, 55, 10, 0, 128, 255] },
    status: 200, media: 'application/json', response: { id: 'doc_example', name: 'Acme guide' },
  },
  {
    id: 'update_file_document_route', profile: 'change',
    args: { path_params: { documentation_id: 'doc/a ?#' }, body: {}, files: [{ field: 'file', file_path: './guide.txt' }] },
    method: 'PATCH', path: '/v1/convai/knowledge-base/doc%2Fa%20%3F%23/update-file', query: [],
    multipart: { scalars: [], field: 'file', fileName: 'guide.txt', mime: 'text/plain', bytes: [65, 99, 109, 101, 10, 0, 128, 255] },
    status: 200, media: 'application/json', response: { ...document, type: 'file', filename: 'guide.txt' },
  },
];
