// Account Types
export interface Account {
  email: string;
  category: string;
  description: string;
  auth_status?: {
    has_token: boolean;
    scopes?: string[];
    expires?: number;
  };
}

export interface AccountsConfig {
  accounts: Account[];
}

// Token Types
export interface TokenData {
  access_token: string;
  refresh_token: string;
  scope: string;
  token_type: string;
  expiry_date: number;
  last_refresh: number;
}

// OAuth Config Types
export interface OAuthConfig {
  client_id: string;
  client_secret: string;
  auth_uri: string;
  token_uri: string;
}

// Error Types
export class GoogleApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly resolution?: string
  ) {
    super(message);
    this.name = 'GoogleApiError';
  }
}
