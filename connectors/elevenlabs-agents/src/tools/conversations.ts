import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  requireApiKey,
  elevenLabsBinaryDownload,
  elevenLabsFetch,
  elevenLabsJson,
} from '../client.js';
import { ENDPOINTS } from '../endpoints.js';
import { sanitizeConversation, sanitizeList } from '../sanitize.js';
import { LONG_REQUEST_TIMEOUT_MS } from '../types.js';
import { withErrorHandling } from '../utils.js';

function extractItems(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (!result || typeof result !== 'object') return [];
  const obj = result as Record<string, unknown>;
  if (Array.isArray(obj.conversations)) return obj.conversations;
  if (Array.isArray(obj.items)) return obj.items;
  if (Array.isArray(obj.data)) return obj.data;
  return [];
}

function extractNextCursor(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const obj = result as Record<string, unknown>;
  return typeof obj.next_cursor === 'string'
    ? obj.next_cursor
    : typeof obj.cursor === 'string'
      ? obj.cursor
      : typeof obj.last_doc === 'string'
        ? obj.last_doc
        : undefined;
}

export function registerConversationTools(server: McpServer): void {
  server.registerTool(
    'list_conversations',
    {
      description: `List conversations in your ElevenLabs Conversational AI workspace.

WHEN TO USE:
- Find a recent conversation ID before pulling the full transcript
- Review calls for one agent over a time range

EXAMPLE: {"agent_id": "agent_123", "page_size": 5}

RELATED TOOLS:
- get_conversation: fetch the full transcript and analysis for one conversation
- get_conversation_audio: download the recording for a returned conversation_id

RETURNS: conversations, count, next_cursor.

FREE.`,
      inputSchema: z.object({
        agent_id: z.string().optional().describe('Only return conversations for this agent.'),
        start_date: z.string().optional().describe('Optional start date/time filter (ISO 8601).'),
        end_date: z.string().optional().describe('Optional end date/time filter (ISO 8601).'),
        call_successful: z.boolean().optional().describe('Optional success filter.'),
        page_size: z.number().int().min(1).max(100).optional()
          .describe('Maximum number of conversations to return (for live checks, use 1).'),
        cursor: z.string().optional().describe('Pagination cursor from the previous response.'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const apiKey = requireApiKey();
      const params = new URLSearchParams();
      if (args.agent_id) params.set('agent_id', args.agent_id);
      if (args.start_date) params.set('start_date', args.start_date);
      if (args.end_date) params.set('end_date', args.end_date);
      if (args.call_successful !== undefined) params.set('call_successful', String(args.call_successful));
      if (args.page_size !== undefined) params.set('page_size', String(args.page_size));
      if (args.cursor) params.set('cursor', args.cursor);
      const qs = params.toString();
      const result = await elevenLabsJson<unknown>(
        apiKey,
        `${ENDPOINTS.CONVERSATIONS}${qs ? `?${qs}` : ''}`,
        { method: 'GET' },
      );
      const items = extractItems(result);
      return JSON.stringify({
        ok: true,
        conversations: sanitizeList(items, sanitizeConversation, 'elevenlabs-agents:list_conversations'),
        count: items.length,
        next_cursor: extractNextCursor(result),
        message: `Found ${items.length} conversation(s).`,
      });
    }),
  );

  server.registerTool(
    'get_conversation',
    {
      description: `Get full details for one conversation, including transcript, caller-provided content, and analysis.

WHEN TO USE:
- Review a single conversation in detail after listing recent conversations
- Inspect transcript text before escalating or making follow-up changes

EXAMPLE: {"conversation_id": "conv_123"}

RELATED TOOLS:
- list_conversations: discover valid conversation IDs
- get_conversation_audio: download the recording for this conversation

RETURNS: conversation.

FREE.`,
      inputSchema: z.object({
        conversation_id: z.string().min(1).describe('Conversation ID to inspect.'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const apiKey = requireApiKey();
      const result = await elevenLabsJson<unknown>(
        apiKey,
        ENDPOINTS.conversation(args.conversation_id),
        { method: 'GET' },
      );
      return JSON.stringify({
        ok: true,
        conversation: sanitizeConversation(result, 'elevenlabs-agents:get_conversation'),
      });
    }),
  );

  server.registerTool(
    'get_conversation_audio',
    {
      description: `Download the audio recording for one conversation to a temporary local file.

WHEN TO USE:
- After get_conversation when you need the original audio
- To preserve evidence from a conversation before sharing it elsewhere

EXAMPLE: {"conversation_id": "conv_123"}

RELATED TOOLS:
- list_conversations: discover conversation IDs
- get_conversation: inspect transcript and analysis alongside the audio

RETURNS: file_path, size_bytes.

FREE.`,
      inputSchema: z.object({
        conversation_id: z.string().min(1).describe('Conversation ID whose recording should be downloaded.'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const apiKey = requireApiKey();
      const downloaded = await elevenLabsBinaryDownload(
        apiKey,
        ENDPOINTS.conversationAudio(args.conversation_id),
        { method: 'GET', timeoutMs: LONG_REQUEST_TIMEOUT_MS },
      );
      return JSON.stringify({
        ok: true,
        file_path: downloaded.filePath,
        size_bytes: downloaded.sizeBytes,
        message: `Conversation audio downloaded to ${downloaded.filePath}.`,
      });
    }),
  );

  server.registerTool(
    'submit_conversation_feedback',
    {
      description: `Submit like/dislike feedback for one conversation, closing the quality-review loop.

WHEN TO USE:
- Mark a conversation as good or bad after reviewing its transcript
- Flag a failed call so it is visible in ElevenLabs analytics

EXAMPLE: {"conversation_id": "conv_123", "feedback": "dislike"}

RELATED TOOLS:
- get_conversation: review the transcript and analysis before judging
- list_conversations: discover conversation IDs to review

RETURNS: ok confirmation.

COST: FREE — but this writes production analytics state (destructiveHint is set).`,
      inputSchema: z.object({
        conversation_id: z.string().min(1).describe('Conversation ID to leave feedback on.'),
        feedback: z.enum(['like', 'dislike'])
          .describe('Thumbs up ("like") or thumbs down ("dislike") for this conversation.'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const apiKey = requireApiKey();
      // Success body is an empty object with no schema upstream, so this call
      // deliberately ignores the body rather than parsing it as JSON.
      await elevenLabsFetch(
        apiKey,
        ENDPOINTS.conversationFeedback(args.conversation_id),
        { method: 'POST', body: JSON.stringify({ feedback: args.feedback }) },
      );
      return JSON.stringify({
        ok: true,
        conversation_id: args.conversation_id,
        feedback: args.feedback,
        message: `Submitted "${args.feedback}" feedback for conversation ${args.conversation_id}.`,
      });
    }),
  );
}
