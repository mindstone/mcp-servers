import { getAccountManager } from '../modules/accounts/index.js';
import { McpToolResponse, BaseToolArguments } from './types.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

/**
 * Helper to ensure email is provided for account management operations
 */
function requireEmail(args: BaseToolArguments): string {
  if (!args.email) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Email address is required for account management operations'
    );
  }
  return args.email;
}

/**
 * Build the super-mcp instance package_id for a Google Workspace account.
 * Mirrors generateInstanceId('GoogleWorkspace', email) from src/shared/utils/mcpInstanceUtils.ts.
 */
function buildPackageId(email: string): string {
  const slug = email
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `GoogleWorkspace-${slug}`;
}

/**
 * Lists all configured Google Workspace accounts and their authentication status
 * @returns List of accounts with their configuration and auth status
 * @throws {McpError} If account manager fails to retrieve accounts
 */
export async function handleListWorkspaceAccounts(): Promise<McpToolResponse> {
  const accounts = await getAccountManager().listAccounts();

  const enrichedAccounts = accounts.map(account => ({
    ...account,
    auth_status: account.auth_status ? {
      valid: account.auth_status.valid,
      status: account.auth_status.status,
      reason: account.auth_status.reason,
      authUrl: account.auth_status.authUrl
    } : undefined,
    package_id: buildPackageId(account.email),
    account_label: account.description
      ? `${account.description} (${account.email})`
      : account.email,
    is_default: false as boolean,
  }));

  const defaultIndex = enrichedAccounts.findIndex(a => a.auth_status?.valid === true);
  const chosenIndex = defaultIndex >= 0 ? defaultIndex : (enrichedAccounts.length > 0 ? 0 : -1);
  if (chosenIndex >= 0) {
    enrichedAccounts[chosenIndex].is_default = true;
  }

  const defaultPackageId = chosenIndex >= 0 ? enrichedAccounts[chosenIndex].package_id : '';

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        accounts: enrichedAccounts,
        default_package_id: defaultPackageId,
      }, null, 2)
    }]
  };
}

export interface AuthenticateAccountArgs extends BaseToolArguments {}

/**
 * Authenticates a Google Workspace account through OAuth2
 * @param args.email - Email address to authenticate
 * @param args.category - Optional account category (e.g., 'work', 'personal')
 * @param args.description - Optional account description
 * @param args.auth_code - OAuth2 authorization code (optional for manual flow)
 * @param args.auto_complete - Whether to automatically complete auth (default: true)
 * @returns Auth URL and instructions for completing authentication
 * @throws {McpError} If validation fails or OAuth flow errors
 */
export async function handleAuthenticateWorkspaceAccount(_args: AuthenticateAccountArgs = {}): Promise<McpToolResponse> {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        status: 'auth_required',
        user_action: { id: 'google.connect_account' },
        agent_action: {
          instruction: "Connect Google Workspace to continue. The user will be redirected to Google's sign-in."
        },
        setupToolName: 'authenticate_workspace_account'
      })
    }]
  };
}

/**
 * Removes a Google Workspace account and its associated authentication tokens
 * @param args.email - Email address of the account to remove
 * @returns Success message if account removed
 * @throws {McpError} If account removal fails
 */
export async function handleRemoveWorkspaceAccount(args: BaseToolArguments): Promise<McpToolResponse> {
  const email = requireEmail(args);
  await getAccountManager().removeAccount(email);
  
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        status: 'success',
        message: `Successfully removed account ${email} and deleted associated tokens`
      }, null, 2)
    }]
  };
}
