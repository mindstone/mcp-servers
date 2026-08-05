import { google } from "googleapis";
import {
  BaseGoogleService,
  GoogleServiceError
} from "../base/BaseGoogleService.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  ListChatSpacesParams,
  ListChatSpacesResponse,
  ListChatMessagesParams,
  ListChatMessagesResponse,
  SendChatMessageParams,
  ChatMessage,
  ChatError
} from "../../modules/chat/types.js";
import { CHAT_SCOPES } from "../../modules/chat/scopes.js";

// Type alias for the Google Chat API client
type ChatApiClient = ReturnType<typeof google.chat>;

/**
 * Chat service implementation extending BaseGoogleService.
 * Handles Google Chat API specific operations (user-authenticated).
 */
export class ChatService extends BaseGoogleService<ChatApiClient> {
  constructor() {
    super({
      serviceName: "chat",
      version: "v1"
    });
    // Initialize immediately or ensure initialized before first use
    this.initialize();
  }

  /**
   * Gets an authenticated Chat API client for the specified account.
   */
  private async getChatClient(email: string): Promise<ChatApiClient> {
    // The clientFactory function tells BaseGoogleService how to create the specific client
    return this.getAuthenticatedClient(email, (auth) =>
      google.chat({ version: "v1", auth })
    );
  }

  /**
   * Lists spaces (DMs, group chats, named spaces) for the specified user account.
   */
  async listSpaces(params: ListChatSpacesParams): Promise<ListChatSpacesResponse> {
    const { email, pageSize, pageToken, filter } = params;

    try {
      // Ensure necessary scopes are granted
      await this.validateScopes(email, [CHAT_SCOPES.SPACES_READONLY]);

      const chatApi = await this.getChatClient(email);

      const response = await chatApi.spaces.list({
        pageSize: pageSize,
        pageToken: pageToken,
        filter: filter
      });

      // Assume the response structure matches ListChatSpacesResponse;
      // googleapis types use 'null' where we defined optional fields ('undefined')
      return response.data as ListChatSpacesResponse;
    } catch (error) {
      throw this.toChatError(error, "Error listing chat spaces");
    }
  }

  /**
   * Lists messages in a space for the specified user account.
   */
  async listMessages(params: ListChatMessagesParams): Promise<ListChatMessagesResponse> {
    const { email, parent, pageSize, pageToken, filter, orderBy } = params;

    if (!parent) {
      throw new ChatError(
        "Missing required parameter: parent",
        "INVALID_PARAMS",
        'Specify the space resource name (e.g. "spaces/AAAA...")'
      );
    }

    try {
      await this.validateScopes(email, [CHAT_SCOPES.MESSAGES_READONLY]);

      const chatApi = await this.getChatClient(email);

      const response = await chatApi.spaces.messages.list({
        parent: parent,
        pageSize: pageSize,
        pageToken: pageToken,
        filter: filter,
        orderBy: orderBy
      });

      return response.data as ListChatMessagesResponse;
    } catch (error) {
      throw this.toChatError(error, "Error listing chat messages");
    }
  }

  /**
   * Posts a plain-text message to a space as the authenticated user.
   */
  async sendMessage(params: SendChatMessageParams): Promise<ChatMessage> {
    const { email, parent, text } = params;

    if (!parent) {
      throw new ChatError(
        "Missing required parameter: parent",
        "INVALID_PARAMS",
        'Specify the space resource name (e.g. "spaces/AAAA...")'
      );
    }
    if (!text) {
      throw new ChatError(
        "Missing required parameter: text",
        "INVALID_PARAMS",
        "Specify the message text to send"
      );
    }

    try {
      await this.validateScopes(email, [CHAT_SCOPES.MESSAGES_CREATE]);

      const chatApi = await this.getChatClient(email);

      const response = await chatApi.spaces.messages.create({
        parent: parent,
        requestBody: { text: text }
      });

      return response.data as ChatMessage;
    } catch (error) {
      throw this.toChatError(error, "Error sending chat message");
    }
  }

  /**
   * Maps errors from Chat API operations to ChatError, mirroring the contacts service:
   * GoogleServiceError keeps its code/details, anything else becomes an unknown error.
   */
  private toChatError(error: unknown, fallbackMessage: string): ChatError {
    // Handle known GoogleServiceError specifically
    if (error instanceof GoogleServiceError) {
      // Assuming GoogleServiceError inherits message and data from McpError
      // Use type assertion as the linter seems unsure
      const gError = error as McpError & {
        data?: { code?: string; details?: string };
      };
      return new ChatError(
        gError.message || fallbackMessage, // Fallback message
        gError.data?.code || "GOOGLE_SERVICE_ERROR", // Code from data
        gError.data?.details // Details from data
      );
    }
    // Handle other potential errors (e.g. network errors)
    else if (error instanceof Error) {
      return new ChatError(
        `${fallbackMessage}: ${error.message}`,
        "UNKNOWN_API_ERROR"
      );
    }
    // Handle non-Error throws
    else {
      return new ChatError(
        `${fallbackMessage} due to an unknown issue`,
        "UNKNOWN_INTERNAL_ERROR"
      );
    }
  }
}
