import { ToolMetadata } from "../../modules/tools/registry.js";

// Account Management Tools
export const accountTools: ToolMetadata[] = [
  {
    name: 'list_workspace_accounts',
    category: 'Account Management',
    description: `List all configured Google workspace accounts and their authentication status.

    IMPORTANT: This tool MUST be called first before any other workspace operations to:
    1. Check for existing authenticated accounts
    2. Determine which account to use if multiple exist
    3. Verify required API scopes are authorized

    Response shape:
    {
      accounts: [
        {
          email, category, description, auth_status,    // unchanged legacy fields
          package_id,        // super-mcp instance id (e.g. "GoogleWorkspace-greg-work-com") — use this when routing tool calls
          account_label,     // human-readable label (description + email)
          is_default         // exactly one account in the list is marked true
        },
        ...
      ],
      default_package_id     // mirrors the package_id of the is_default account; empty string if no accounts
    }

    Common Response Patterns:
    - Valid account exists → Proceed with requested operation (use its package_id)
    - Multiple accounts exist → Ask user which to use; fall back to default_package_id if user has no preference
    - Token expired → Proceed normally (auto-refresh occurs)
    - No accounts exist → Start authentication flow

    Example Usage:
    1. User asks to "check email"
    2. Call this tool first to validate account access
    3. If account valid, proceed to email operations
    4. If multiple accounts, ask user "Which account would you like to use?"
    5. Remember chosen account for subsequent operations`,
    aliases: ['list_accounts', 'get_accounts', 'show_accounts'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'authenticate_workspace_account',
    category: 'Account Management',
    description: `Request host-orchestrated Google Workspace account connection.

    This tool does not generate an OAuth URL or run a callback server. It returns a structured auth_required response that tells the MCP host to start its Google connection flow.`,
    aliases: ['auth_account', 'add_account', 'connect_account'],
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'remove_workspace_account',
    category: 'Account Management',
    description: 'Remove a Google account and delete its associated authentication tokens',
    aliases: ['delete_account', 'disconnect_account', 'remove_account'],
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Google account to remove'
        }
      },
      required: ['email']
    }
  }
];
