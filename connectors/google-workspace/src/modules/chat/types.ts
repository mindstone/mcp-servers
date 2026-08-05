/**
 * Parameters for listing Google Chat spaces.
 */
export interface ListChatSpacesParams {
  email: string; // The user account email
  pageSize?: number; // Max number of spaces to return (capped by the handler)
  pageToken?: string; // Token for pagination
  filter?: string; // Optional filter, e.g. 'space_type = "SPACE"'
}

/**
 * Response structure for listing spaces.
 */
export interface ListChatSpacesResponse {
  spaces: ChatSpace[];
  nextPageToken?: string;
}

/**
 * Parameters for listing messages in a space.
 */
export interface ListChatMessagesParams {
  email: string; // The user account email
  parent: string; // Space resource name, e.g. "spaces/AAAA..."
  pageSize?: number; // Max number of messages to return (capped by the handler)
  pageToken?: string; // Token for pagination
  filter?: string; // Optional filter (create_time / thread.name)
  orderBy?: string; // Optional ordering, e.g. "create_time desc"
}

/**
 * Response structure for listing messages.
 */
export interface ListChatMessagesResponse {
  messages: ChatMessage[];
  nextPageToken?: string;
}

/**
 * Parameters for sending a text message to a space.
 */
export interface SendChatMessageParams {
  email: string; // The user account email
  parent: string; // Space resource name, e.g. "spaces/AAAA..."
  text: string; // Plain-text message body
}

/**
 * Represents a Google Chat space (DM, group chat, or named space).
 * Based on the Chat API Space resource.
 * Reference: https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces#Space
 */
export interface ChatSpace {
  name: string; // Resource name, e.g. "spaces/AAAA..."
  displayName?: string; // May be empty for direct messages
  spaceType?: string; // "SPACE" | "GROUP_CHAT" | "DIRECT_MESSAGE"
  singleUserBotDm?: boolean;
  threaded?: boolean;
  externalUserAllowed?: boolean;
  spaceUri?: string;
  createTime?: string;
}

/**
 * Represents a user (sender) on a Chat message.
 */
export interface ChatUser {
  name?: string; // Resource name, e.g. "users/123..."
  displayName?: string;
  type?: string; // "HUMAN" | "BOT"
}

/**
 * Represents a Google Chat message.
 * Based on the Chat API Message resource.
 * Reference: https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages#Message
 */
export interface ChatMessage {
  name: string; // Resource name, e.g. "spaces/AAAA.../messages/BBBB..."
  text?: string; // Plain-text body
  createTime?: string;
  sender?: ChatUser;
  thread?: { name?: string };
}

/**
 * Base error class for Chat service.
 */
export class ChatError extends Error {
  code: string;
  details?: string;

  constructor(message: string, code: string, details?: string) {
    super(message);
    this.name = "ChatError";
    this.code = code;
    this.details = details;
  }
}
