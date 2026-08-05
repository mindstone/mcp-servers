import {
  ListChatSpacesResponse,
  ListChatMessagesResponse,
  ChatMessage
} from "../modules/chat/types.js";
import { ChatService } from "../services/chat/index.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { toMcpError } from "../utils/apiError.js";
import { getAccountManager, resolveEmail } from "../modules/accounts/index.js";
import {
  readAliasedNumber,
  readAliasedString
} from './arg-aliases.js';
import { wrapUntrustedJsonStrings } from "../utils/untrusted-content.js";

// Cap page sizes well below the Chat API maximum (1000) to keep responses manageable
const MAX_CHAT_PAGE_SIZE = 100;

// Google Chat documents a maximum TOTAL message size of 32,000 bytes
// (spaces.messages.create). Enforce it against the UTF-8 byte length of the
// text body — the only sizable field this tool sends.
const MAX_CHAT_MESSAGE_TEXT_BYTES = 32_000;

// Space resource names look like "spaces/AAAA..." — exactly one segment after the prefix.
const SPACE_NAME_PATTERN = /^spaces\/[^/\s]+$/;

// Singleton instances - Initialize or inject as per project pattern
let chatService: ChatService;
let accountManager: ReturnType<typeof getAccountManager>;

/**
 * Initialize required services.
 * This should likely be integrated into a central initialization process.
 */
async function initializeServices() {
  if (!chatService) {
    chatService = new ChatService();
  }

  if (!accountManager) {
    accountManager = getAccountManager();
  }
}

function capPageSize(pageSize: number | undefined): number | undefined {
  return pageSize !== undefined ? Math.min(pageSize, MAX_CHAT_PAGE_SIZE) : undefined;
}

function requireSpaceName(space: string | undefined): string {
  if (!space || !SPACE_NAME_PATTERN.test(space)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'space must be a space resource name of the form "spaces/<id>" (e.g. "spaces/AAAA...")'
    );
  }
  return space;
}

/**
 * Handler function for listing Google Chat spaces.
 */
export async function handleListChatSpaces(
  params: Record<string, unknown>
): Promise<ListChatSpacesResponse> {
  await initializeServices(); // Ensure services are ready
  const pageSize = readAliasedNumber(params, 'page_size', 'pageSize');
  const pageToken = readAliasedString(params, 'page_token', 'pageToken');
  const filter = typeof params.filter === 'string' ? params.filter : undefined;

  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(params);

  // Use accountManager for token renewal like in Contacts handlers
  return accountManager.withTokenRenewal(email, async () => {
    try {
      const result = await chatService.listSpaces({
        email,
        pageSize: capPageSize(pageSize),
        pageToken,
        filter
      });
      return wrapUntrustedJsonStrings(result, 'google-workspace:chat:spaces');
    } catch (error) {
      // toMcpError passes an McpError (and auth-handoff errors) through unchanged, and folds
      // a ChatError's details into the message so the real cause reaches the user.
      throw toMcpError(error, 'Failed to list chat spaces');
    }
  });
}

/**
 * Handler function for listing messages in a Google Chat space.
 */
export async function handleListChatMessages(
  params: Record<string, unknown>
): Promise<ListChatMessagesResponse> {
  await initializeServices();
  const pageSize = readAliasedNumber(params, 'page_size', 'pageSize');
  const pageToken = readAliasedString(params, 'page_token', 'pageToken');
  const filter = typeof params.filter === 'string' ? params.filter : undefined;
  const orderBy = readAliasedString(params, 'order_by', 'orderBy');
  const space = requireSpaceName(readAliasedString(params, 'space', 'space'));

  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(params);

  return accountManager.withTokenRenewal(email, async () => {
    try {
      const result = await chatService.listMessages({
        email,
        parent: space,
        pageSize: capPageSize(pageSize),
        pageToken,
        filter,
        orderBy
      });
      return wrapUntrustedJsonStrings(result, 'google-workspace:chat:messages');
    } catch (error) {
      throw toMcpError(error, 'Failed to list chat messages');
    }
  });
}

/**
 * Handler function for posting a text message to a Google Chat space.
 */
export async function handleSendChatMessage(
  params: Record<string, unknown>
): Promise<ChatMessage> {
  await initializeServices();
  const space = requireSpaceName(readAliasedString(params, 'space', 'space'));
  const text = readAliasedString(params, 'text', 'text');

  if (!text) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'text parameter is required (the plain-text message body to send)'
    );
  }
  const textBytes = Buffer.byteLength(text, 'utf8');
  if (textBytes > MAX_CHAT_MESSAGE_TEXT_BYTES) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `text exceeds the Chat message size limit of ${MAX_CHAT_MESSAGE_TEXT_BYTES} bytes (got ${textBytes})`
    );
  }

  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(params);

  return accountManager.withTokenRenewal(email, async () => {
    try {
      const result = await chatService.sendMessage({
        email,
        parent: space,
        text
      });
      return wrapUntrustedJsonStrings(result, 'google-workspace:chat:message');
    } catch (error) {
      throw toMcpError(error, 'Failed to send chat message');
    }
  });
}
