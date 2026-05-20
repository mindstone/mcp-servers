import 'isomorphic-fetch';
import { Client } from '@microsoft/microsoft-graph-client';
import { TokenProvider, MicrosoftAccount } from './tokenProvider.js';
import { createLogger, redactEmail } from './logger.js';

const log = createLogger('microsoft-graph');

export interface GraphClientOptions {
  configDir: string;
  clientId: string;
  email?: string;
}

class GraphAuthProvider {
  private tokenProvider: TokenProvider;
  private email?: string;

  constructor(tokenProvider: TokenProvider, email?: string) {
    this.tokenProvider = tokenProvider;
    this.email = email;
  }

  async getAccessToken(): Promise<string> {
    return this.tokenProvider.getAccessToken(this.email);
  }
}

let sharedTokenProvider: TokenProvider | null = null;

export function getTokenProvider(options: { configDir: string; clientId: string }): TokenProvider {
  if (!sharedTokenProvider) {
    sharedTokenProvider = new TokenProvider(options.configDir, options.clientId);
  }
  return sharedTokenProvider;
}

export async function listMicrosoftAccounts(options: { configDir: string; clientId: string }): Promise<MicrosoftAccount[]> {
  const tokenProvider = getTokenProvider(options);
  return tokenProvider.loadAccounts();
}

export interface GraphClientWithRetry {
  client: Client;
  tokenProvider: TokenProvider;
}

export function createGraphClient(options: GraphClientOptions): Client {
  const result = createGraphClientWithRetry(options);
  return result.client;
}

export function createGraphClientWithRetry(options: GraphClientOptions): GraphClientWithRetry {
  const tokenProvider = new TokenProvider(options.configDir, options.clientId, options.email);
  const authProvider = new GraphAuthProvider(tokenProvider, options.email);

  log.debug('Creating Microsoft Graph client', {
    configDir: options.configDir,
    account: options.email ? redactEmail(options.email) : 'default',
  });

  const client = Client.initWithMiddleware({
    authProvider: {
      getAccessToken: () => authProvider.getAccessToken(),
    },
    defaultVersion: 'v1.0',
  });

  return { client, tokenProvider };
}

export async function checkGraphConnection(client: Client): Promise<{ connected: boolean; email?: string; error?: string }> {
  try {
    const me = await client.api('/me').select('mail,userPrincipalName,displayName').get();
    return {
      connected: true,
      email: me.mail ?? me.userPrincipalName,
    };
  } catch (err) {
    return {
      connected: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}
