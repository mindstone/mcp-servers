let apiKey: string = process.env.RECRAFT_API_KEY || '';

export function getApiKey(): string {
  return apiKey;
}

export function isConfigured(): boolean {
  return apiKey.length > 0;
}

export function setApiKey(key: string): void {
  apiKey = key;
}
