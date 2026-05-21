import { getHubSpotClientAsync } from '../api/hubspot-client.js';
import { parseHubSpotError } from '../utils/error-parser.js';
import logger from '../utils/logger.js';

export interface ListTicketThreadsArgs {
  ticketId: string;
  threadStatus?: 'OPEN' | 'CLOSED';
  limit?: number;
  after?: string;
  archived?: boolean;
}

export interface ListThreadMessagesArgs {
  threadId: string;
  limit?: number;
  after?: string;
}

export interface GetThreadMessageOriginalContentArgs {
  threadId: string;
  messageId: string;
}

export async function handleListTicketThreads(args: ListTicketThreadsArgs) {
  if (!args.ticketId) {
    throw new Error(
      JSON.stringify({
        errorCode: 'INVALID_ARGUMENTS',
        message: 'ticketId is required',
        suggestion: 'Pass the HubSpot ticket ID (numeric string).',
      })
    );
  }
  try {
    const client = await getHubSpotClientAsync();
    return await client.listConversationThreads({
      associatedTicketId: args.ticketId,
      threadStatus: args.threadStatus,
      limit: args.limit,
      after: args.after,
      archived: args.archived,
    });
  } catch (error) {
    const parsed = parseHubSpotError(error, {
      objectType: 'conversations',
      operation: 'list_threads',
      args,
    });
    logger.error('list_hubspot_ticket_threads failed:', parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

export async function handleListThreadMessages(args: ListThreadMessagesArgs) {
  if (!args.threadId) {
    throw new Error(
      JSON.stringify({
        errorCode: 'INVALID_ARGUMENTS',
        message: 'threadId is required',
        suggestion: 'Resolve the threadId from list_hubspot_ticket_threads first.',
      })
    );
  }
  try {
    const client = await getHubSpotClientAsync();
    return await client.listConversationThreadMessages(args.threadId, {
      limit: args.limit,
      after: args.after,
    });
  } catch (error) {
    const parsed = parseHubSpotError(error, {
      objectType: 'conversations',
      operation: 'list_messages',
      args,
    });
    logger.error('list_hubspot_thread_messages failed:', parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

export async function handleGetThreadMessageOriginalContent(
  args: GetThreadMessageOriginalContentArgs
) {
  if (!args.threadId || !args.messageId) {
    throw new Error(
      JSON.stringify({
        errorCode: 'INVALID_ARGUMENTS',
        message: 'threadId and messageId are both required',
        suggestion:
          'Use this tool only when a message returned from list_hubspot_thread_messages has truncationStatus indicating truncation.',
      })
    );
  }
  try {
    const client = await getHubSpotClientAsync();
    return await client.getConversationThreadMessageOriginalContent(
      args.threadId,
      args.messageId
    );
  } catch (error) {
    const parsed = parseHubSpotError(error, {
      objectType: 'conversations',
      operation: 'get_message_original_content',
      args,
    });
    logger.error('get_hubspot_thread_message_original_content failed:', parsed);
    throw new Error(JSON.stringify(parsed));
  }
}
