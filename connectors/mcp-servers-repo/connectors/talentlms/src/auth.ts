/**
 * TalentLMS authentication module.
 *
 * API key + domain management — stored via env vars (TALENTLMS_API_KEY, TALENTLMS_DOMAIN)
 * or configured at runtime via the configure_talentlms tool.
 *
 * Auth: Basic auth with base64(apiKey:) — colon after key, empty password.
 */

const MULTI_LABEL_SUBDOMAIN_REGEX = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

const extractHostnameFromUserInput = (input: string): string => {
  const trimmed = input.trim();
  if (!trimmed) return '';
  const candidate = trimmed.includes('://') ? trimmed : `https://${trimmed}`;
  try {
    return new URL(candidate).hostname.toLowerCase();
  } catch {
    return trimmed
      .toLowerCase()
      .replace(/^[a-z]+:\/\//, '')
      .split('/')[0]
      .split('?')[0]
      .split('#')[0]
      .split(':')[0];
  }
};

/**
 * Normalize a user-provided domain input to a subdomain.
 * Handles full URLs like "https://acme.talentlms.com" → "acme",
 * bare domains like "acme.talentlms.com" → "acme", and plain subdomains.
 */
export const normalizeTalentLmsSubdomainInput = (input: string | undefined): string | undefined => {
  if (!input) return undefined;
  const hostname = extractHostnameFromUserInput(input);
  if (!hostname) return undefined;

  const normalizedHostname = hostname.trim().toLowerCase().replace(/\.$/, '');
  const withoutSuffix = normalizedHostname.endsWith('.talentlms.com')
    ? normalizedHostname.slice(0, -'.talentlms.com'.length)
    : normalizedHostname;

  return withoutSuffix || undefined;
};

/**
 * Validate that a subdomain value is safe to use in a URL.
 */
export function isValidSubdomain(value: string): boolean {
  return MULTI_LABEL_SUBDOMAIN_REGEX.test(value);
}

/** Runtime API key — starts from env, can be updated via configure tool. */
let apiKey: string = process.env.TALENTLMS_API_KEY ?? '';

/** Runtime domain — starts from env, can be updated via configure tool. */
let domain: string = normalizeTalentLmsSubdomainInput(process.env.TALENTLMS_DOMAIN) ?? '';

export function getApiKey(): string {
  return apiKey;
}

export function setApiKey(key: string): void {
  apiKey = key;
}

export function getDomain(): string {
  return domain;
}

export function setDomain(d: string): void {
  domain = d;
}

export function isConfigured(): boolean {
  return apiKey.trim().length > 0 && domain.trim().length > 0;
}
