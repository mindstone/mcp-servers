/**
 * Canonical ElevenLabs Conversational AI endpoint paths.
 *
 * Every `/v1/convai/*` path used by this connector lives here so a wrong path
 * is a one-line fix. Declarations without a tool behind them are removed
 * rather than kept as forward-looking signposts.
 */

export const ELEVENLABS_API_V1_BASE = 'https://api.elevenlabs.io/v1';

export const ENDPOINTS = {
  AGENTS: '/convai/agents',
  AGENTS_CREATE: '/convai/agents/create',
  CONVERSATIONS: '/convai/conversations',
  PHONE_NUMBERS: '/convai/phone-numbers',
  KNOWLEDGE_BASE: '/convai/knowledge-base',
  KNOWLEDGE_BASE_TEXT: '/convai/knowledge-base/text',
  KNOWLEDGE_BASE_FILE: '/convai/knowledge-base/file',
  KNOWLEDGE_BASE_URL: '/convai/knowledge-base/url',
  TWILIO_OUTBOUND_CALL: '/convai/twilio/outbound-call',
  SIP_TRUNK_OUTBOUND_CALL: '/convai/sip-trunk/outbound-call',
  BATCH_CALLS_SUBMIT: '/convai/batch-calling/submit',
  BATCH_CALLS_WORKSPACE: '/convai/batch-calling/workspace',
  TOOLS: '/convai/tools',
  agent: (agentId: string) => `/convai/agents/${encodeURIComponent(agentId)}`,
  agentDuplicate: (agentId: string) => `/convai/agents/${encodeURIComponent(agentId)}/duplicate`,
  agentSimulateConversation: (agentId: string) =>
    `/convai/agents/${encodeURIComponent(agentId)}/simulate-conversation`,
  conversation: (conversationId: string) => `/convai/conversations/${encodeURIComponent(conversationId)}`,
  conversationAudio: (conversationId: string) =>
    `/convai/conversations/${encodeURIComponent(conversationId)}/audio`,
  conversationFeedback: (conversationId: string) =>
    `/convai/conversations/${encodeURIComponent(conversationId)}/feedback`,
  phoneNumber: (phoneNumberId: string) => `/convai/phone-numbers/${encodeURIComponent(phoneNumberId)}`,
  knowledgeBaseDoc: (documentationId: string) =>
    `/convai/knowledge-base/${encodeURIComponent(documentationId)}`,
  knowledgeBaseDocContent: (documentationId: string) =>
    `/convai/knowledge-base/${encodeURIComponent(documentationId)}/content`,
  knowledgeBaseRagIndex: (documentationId: string) =>
    `/convai/knowledge-base/${encodeURIComponent(documentationId)}/rag-index`,
  batchCall: (batchId: string) => `/convai/batch-calling/${encodeURIComponent(batchId)}`,
  batchCallCancel: (batchId: string) => `/convai/batch-calling/${encodeURIComponent(batchId)}/cancel`,
  batchCallRetry: (batchId: string) => `/convai/batch-calling/${encodeURIComponent(batchId)}/retry`,
} as const;
