import fs from 'node:fs/promises';
import path from 'node:path';
import logger from '../../utils/logger.js';

export interface HubSpotAccountInfo {
  email: string;
  hubId: number;
  status: 'active' | 'expired' | 'error';
  scopeTier?: 'readonly' | 'full';
  grantedScopes?: string[];
}

export interface TokenData {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  hub_id?: number;
  user?: string;
  grantedScopes?: string[];
}

export function sanitizeEmail(email: string): string {
  return email.replace(/[^a-zA-Z0-9]/g, '-');
}

class AccountManager {
  private configDir: string;
  
  constructor() {
    this.configDir = process.env.HUBSPOT_CONFIG_DIR || path.join(process.env.HOME || '', '.hubspot-mcp');
  }
  
  private get accountsPath(): string {
    return path.join(this.configDir, 'accounts.json');
  }
  
  private get credentialsDir(): string {
    return path.join(this.configDir, 'credentials');
  }

  private getTokenPath(email: string): string {
    return path.join(this.credentialsDir, `${sanitizeEmail(email)}.token.json`);
  }
  
  async getAccounts(): Promise<HubSpotAccountInfo[]> {
    try {
      const data = await fs.readFile(this.accountsPath, 'utf-8');
      const config = JSON.parse(data) as { accounts: Array<{ email: string; hubId: number; scopeTier?: 'readonly' | 'full'; grantedScopes?: string[] }> };
      
      const results: HubSpotAccountInfo[] = [];
      
      for (const account of config.accounts || []) {
        const token = await this.getToken(account.email);
        let status: 'active' | 'expired' | 'error' = 'error';
        
        if (token) {
          // Use 5-minute buffer to match auto-refresh logic
          const bufferMs = 5 * 60 * 1000;
          const isValid = token.expires_at && token.expires_at > (Date.now() + bufferMs);
          
          if (isValid) {
            status = 'active';
          } else if (token.refresh_token) {
            // Token expired but has refresh_token - will auto-refresh on next use
            status = 'active';
          } else {
            status = 'expired';
          }
        }
        
        results.push({
          email: account.email,
          hubId: account.hubId,
          status,
          scopeTier: account.scopeTier,
          grantedScopes: account.grantedScopes,
        });
      }
      
      return results;
    } catch {
      return [];
    }
  }
  
  async getToken(email: string): Promise<TokenData | null> {
    try {
      const data = await fs.readFile(this.getTokenPath(email), 'utf-8');
      return JSON.parse(data) as TokenData;
    } catch {
      return null;
    }
  }
  
  async saveToken(email: string, tokenData: TokenData): Promise<void> {
    await fs.mkdir(this.credentialsDir, { recursive: true, mode: 0o700 });
    const tokenPath = this.getTokenPath(email);
    await fs.writeFile(tokenPath, JSON.stringify(tokenData, null, 2), { mode: 0o600 });
    await fs.chmod(tokenPath, 0o600);
    
    const hubId = tokenData.hub_id || 0;
    
    // Update accounts list - preserve existing fields like scopeTier
    let accounts: Array<{ email: string; hubId: number; scopeTier?: 'readonly' | 'full'; grantedScopes?: string[] }> = [];
    try {
      const data = await fs.readFile(this.accountsPath, 'utf-8');
      const config = JSON.parse(data);
      accounts = config.accounts || [];
    } catch {
      // File doesn't exist yet
    }
    
    const existing = accounts.find(a => a.email === email);
    if (existing) {
      // Update hubId and grantedScopes, preserve other fields like scopeTier
      existing.hubId = hubId;
      if (tokenData.grantedScopes) {
        existing.grantedScopes = tokenData.grantedScopes;
      }
    } else {
      accounts.push({ email, hubId, grantedScopes: tokenData.grantedScopes });
    }
    
    await fs.mkdir(this.configDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(this.accountsPath, JSON.stringify({ accounts }, null, 2), { mode: 0o600 });
    await fs.chmod(this.accountsPath, 0o600);
    
    logger.info(`Saved token for ${email}`);
  }
  
  async removeAccount(email: string): Promise<void> {
    // Remove token file
    try {
      await fs.unlink(this.getTokenPath(email));
    } catch {
      // Ignore if doesn't exist
    }
    
    // Remove from accounts list
    try {
      const data = await fs.readFile(this.accountsPath, 'utf-8');
      const config = JSON.parse(data) as { accounts: Array<{ email: string; hubId: number }> };
      config.accounts = (config.accounts || []).filter(a => a.email !== email);
      await fs.writeFile(this.accountsPath, JSON.stringify(config, null, 2), { mode: 0o600 });
      await fs.chmod(this.accountsPath, 0o600);
    } catch {
      // Ignore
    }
    
    logger.info(`Removed account ${email}`);
  }

  async hasConfiguredAccountEmail(): Promise<boolean> {
    const configuredEmail = process.env.HUBSPOT_ACCOUNT_EMAIL;
    if (!configuredEmail) {
      return false;
    }

    const accounts = await this.getAccounts();
    const matchingAccount = accounts.find((account) => account.email === configuredEmail);
    if (!matchingAccount) {
      return false;
    }

    const token = await this.getToken(configuredEmail);
    return !!token?.access_token;
  }

  /**
   * Get the email address configured for this MCP instance.
   * In multi-instance mode, each MCP instance handles exactly one account.
   * @throws {Error} if HUBSPOT_ACCOUNT_EMAIL is missing, mismatched, or no accounts exist
   */
  async getCurrentAccountEmail(): Promise<string> {
    const configuredEmail = process.env.HUBSPOT_ACCOUNT_EMAIL;
    if (!configuredEmail) {
      throw new Error('HUBSPOT_ACCOUNT_EMAIL is required for HubSpot MCP tool calls. Set it to a connected account email.');
    }

    const accounts = await this.getAccounts();
    if (accounts.length === 0) {
      throw new Error('No HubSpot accounts connected. Please authenticate first.');
    }

    const matchingAccount = accounts.find((account) => account.email === configuredEmail);
    if (!matchingAccount) {
      throw new Error(
        `HUBSPOT_ACCOUNT_EMAIL (${configuredEmail}) does not match any connected HubSpot account. Please reconnect or select a valid account email.`
      );
    }

    return matchingAccount.email;
  }
}

let managerInstance: AccountManager | null = null;

export function getAccountManager(): AccountManager {
  if (!managerInstance) {
    managerInstance = new AccountManager();
  }
  return managerInstance;
}
