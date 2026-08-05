import { ToolMetadata } from "../../modules/tools/registry.js";

// Define Chat Tools
export const chatTools: ToolMetadata[] = [
  {
    name: "list_chat_spaces",
    category: "Chat",
    description: `List Google Chat spaces (direct messages, group chats, and named spaces) for the authenticated user.

    IMPORTANT: Before using this tool:
    1. Verify account access with list_workspace_accounts
    2. Confirm account if multiple exist
    3. Check required scopes include Chat read access

    Parameters:
    - email: The Google account email to list spaces for
    - page_size: Optional maximum number of spaces to return (max 100)
    - page_token: Optional token for pagination (to get the next page)
    - filter: Optional filter by space type (e.g. 'space_type = "SPACE"')

    Example Usage:
    1. Call list_workspace_accounts to check for valid accounts
    2. Call list_chat_spaces to retrieve spaces
    3. Use the space "name" field (e.g. "spaces/AAAA...") with list_chat_messages or send_chat_message`,
    aliases: ["list_spaces", "get_chat_spaces"],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        email: {
          type: "string",
          description: "Email address of the Google account"
        },
        page_size: {
          type: "number",
          description: "Maximum number of spaces to return (default: API default, max: 100)"
        },
        page_token: {
          type: "string",
          description: "Page token from a previous response (for pagination)"
        },
        filter: {
          type: "string",
          description: 'Optional filter by space type (e.g. \'space_type = "SPACE"\' or \'space_type = "GROUP_CHAT"\')'
        }
      },
      required: []
    }
  },
  {
    name: "list_chat_messages",
    category: "Chat",
    description: `List messages in a Google Chat space.

    Use list_chat_spaces first to find the space resource name (e.g. "spaces/AAAA...").

    Parameters:
    - email: The Google account email to read messages for
    - space: Required space resource name (e.g. "spaces/AAAA...")
    - page_size: Optional maximum number of messages to return (max 100)
    - page_token: Optional token for pagination (to get the next page)
    - filter: Optional filter (e.g. 'create_time > "2026-01-01T00:00:00+00:00"')
    - order_by: Optional ordering (e.g. "create_time desc"; default is create_time ascending)

    Example usage:
    - Recent messages: { "space": "spaces/AAAA...", "page_size": 20, "order_by": "create_time desc" }`,
    aliases: ["list_messages", "get_chat_messages"],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        email: {
          type: "string",
          description: "Email address of the Google account"
        },
        space: {
          type: "string",
          description: 'Space resource name, e.g. "spaces/AAAA..." (from list_chat_spaces)'
        },
        page_size: {
          type: "number",
          description: "Maximum number of messages to return (default: 25, max: 100)"
        },
        page_token: {
          type: "string",
          description: "Page token from a previous response (for pagination)"
        },
        filter: {
          type: "string",
          description: 'Optional filter by create_time and/or thread.name (e.g. \'create_time > "2026-01-01T00:00:00+00:00"\')'
        },
        order_by: {
          type: "string",
          description: 'Optional ordering, e.g. "create_time desc" (default: create_time ascending)'
        }
      },
      required: ["space"]
    }
  },
  {
    name: "send_chat_message",
    category: "Chat",
    description: `Post a plain-text message to a Google Chat space as the authenticated user.

    This sends a real message visible to everyone in the space. Confirm the space
    and the message content with the user before sending.

    Use list_chat_spaces first to find the space resource name (e.g. "spaces/AAAA...").

    Parameters:
    - email: The Google account email to send from
    - space: Required space resource name (e.g. "spaces/AAAA...")
    - text: Required plain-text message body

    Example usage:
    - { "space": "spaces/AAAA...", "text": "Meeting moved to 3pm" }`,
    aliases: ["send_message", "post_chat_message"],
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      properties: {
        email: {
          type: "string",
          description: "Email address of the Google account"
        },
        space: {
          type: "string",
          description: 'Space resource name, e.g. "spaces/AAAA..." (from list_chat_spaces)'
        },
        text: {
          type: "string",
          description: "Plain-text message body to post to the space"
        }
      },
      required: ["space", "text"]
    }
  }
];
