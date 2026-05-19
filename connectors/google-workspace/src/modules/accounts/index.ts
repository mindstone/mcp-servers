import { AccountManager } from './manager.js';
import { TokenManager } from './token.js';
import { GoogleOAuthClient } from './oauth.js';
import { Account, AccountError, TokenStatus, AccountModuleConfig } from './types.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

// Create singleton instance
let accountManager: AccountManager | null = null;

export async function initializeAccountModule(config?: AccountModuleConfig): Promise<AccountManager> {
  if (!accountManager) {
    accountManager = new AccountManager(config);
    await accountManager.initialize();
  }
  return accountManager;
}

export function getAccountManager(): AccountManager {
  if (!accountManager) {
    throw new AccountError(
      'Account module not initialized',
      'MODULE_NOT_INITIALIZED',
      'Call initializeAccountModule before using the account manager'
    );
  }
  return accountManager;
}

export function validateEmail(email: string): void {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    throw new Error(`Invalid email address: ${email}`);
  }
}

export async function resolveEmail(args: { email?: string }): Promise<string> {
  const instanceEmail = await getAccountManager().getCurrentAccountEmail();
  
  if (args.email) {
    validateEmail(args.email);
    
    if (args.email !== instanceEmail) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `This MCP instance is configured for ${instanceEmail}. ` +
        `To access ${args.email}, use the MCP instance configured for that account. ` +
        `NOTE: If you're trying to view another person's calendar, don't set 'email' to their address. ` +
        `Instead, use calendarId (for shared calendars with reader access) or find_free_slots with attendees (for free/busy info).`
      );
    }
  }
  
  return instanceEmail;
}

export {
  AccountManager,
  TokenManager,
  GoogleOAuthClient,
  Account,
  AccountError,
  TokenStatus,
  AccountModuleConfig
};
