import { getAccountManager } from '../modules/accounts/manager.js';
import { deriveHubSpotAccountHash } from '../utils/accountHash.js';
import logger from '../utils/logger.js';

export interface AuthenticateAccountArgs {
  email?: string;
}

export interface CompleteAuthArgs {
  email?: string;
}

export interface RemoveAccountArgs {
  email?: string;
}

export function buildHubSpotAuthRequiredResponse() {
  return {
    status: 'auth_required',
    user_action: { id: 'hubspot.connect_account' },
    agent_action: {
      instruction:
        'Tell the user that HubSpot needs reauthentication. The host will open the OAuth flow in their browser; once complete, retry the original request.'
    },
    setupToolName: 'authenticate_hubspot_account'
  };
}

export async function handleListAccounts() {
  const manager = getAccountManager();
  const accounts = await manager.getAccounts();
  
  if (accounts.length === 0) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          accounts: [],
          message: 'No HubSpot accounts connected.',
          next_step: 'To connect a HubSpot account, call authenticate_hubspot_account. The host will open the OAuth flow and retry once complete.'
        }, null, 2)
      }]
    };
  }
  
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        accounts: accounts.map(a => ({
          email: a.email,
          hub_id: a.hubId,
          status: a.status
        })),
        message: `Found ${accounts.length} connected HubSpot account(s).`,
        hint: 'Use the email address when calling other HubSpot tools.'
      }, null, 2)
    }]
  };
}

export async function handleAuthenticateAccount(_args: AuthenticateAccountArgs) {
  return buildHubSpotAuthRequiredResponse();
}

export async function handleCompleteAuth(_args: CompleteAuthArgs) {
  return buildHubSpotAuthRequiredResponse();
}

export async function handleRemoveAccount(args: RemoveAccountArgs) {
  try {
    const manager = getAccountManager();
    
    if (!args.email) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            status: 'error',
            message: 'Email address is required to remove an account.'
          }, null, 2)
        }],
        isError: true
      };
    }

    if (args.email !== process.env.HUBSPOT_ACCOUNT_EMAIL) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            status: 'error',
            errorCode: 'WRONG_ACCOUNT',
            message: 'Can only remove the configured account.'
          }, null, 2)
        }],
        isError: true
      };
    }
    
    await manager.removeAccount(args.email);
    logger.info({ account: deriveHubSpotAccountHash(args.email) }, 'account_removed');
    
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          status: 'success',
          message: 'Successfully disconnected the configured HubSpot account.',
          note: 'To reconnect, use authenticate_hubspot_account.'
        }, null, 2)
      }]
    };
  } catch (error) {
    logger.error('Failed to remove HubSpot account:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          status: 'error',
          message: `Failed to remove account: ${errorMessage}`
        }, null, 2)
      }],
      isError: true
    };
  }
}
