import { getAccountManager } from '../modules/accounts/index.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

/**
 * Validate email address format
 */
export function validateEmail(email: string): void {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    throw new Error(`Invalid email address: ${email}`);
  }
}

/**
 * Resolve the email to use for an operation.
 * 
 * In multi-instance mode (one MCP instance per account), this:
 * 1. Returns args.email if provided AND matches the instance's account
 * 2. Throws a clear error if args.email differs from instance account (use correct MCP instance)
 * 3. Falls back to getCurrentAccountEmail() if no email provided
 * 
 * This ensures backward compatibility while enforcing single-account-per-instance semantics.
 * 
 * @param args - Arguments object that may contain an optional email field
 * @returns The resolved email address to use
 * @throws McpError if the provided email doesn't match the instance account or no accounts exist
 */
export async function resolveEmail(args: { email?: string }): Promise<string> {
  const accountManager = getAccountManager();
  const instanceEmail = await accountManager.getCurrentAccountEmail();
  
  if (args.email) {
    // Validate the provided email format
    validateEmail(args.email);
    
    // If provided email doesn't match instance email, reject with clear error
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
