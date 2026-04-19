/**
 * ServiceNow authentication module.
 *
 * Manages instance name + username/password lifecycle — env var on startup,
 * runtime update via configure tool, and bridge integration for host-app
 * credential management.
 *
 * Uses Basic auth: Authorization: Basic base64(username:password)
 */

import { SINGLE_LABEL_INSTANCE_REGEX } from './types.js';

let instance: string = '';
let username: string = process.env.SERVICENOW_USERNAME || '';
let password: string = process.env.SERVICENOW_PASSWORD || '';

/**
 * Extracts a hostname from a user-provided input string.
 * Handles URLs, bare hostnames, and various formats.
 */
function extractHostnameFromUserInput(input: string): string {
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
}

/**
 * Normalizes a user-provided ServiceNow instance input to just the subdomain label.
 * Accepts: "acme", "acme.service-now.com", "https://acme.service-now.com", etc.
 * Returns undefined if the input is invalid.
 */
export function normalizeServiceNowInstanceInput(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const hostname = extractHostnameFromUserInput(input);
  if (!hostname) return undefined;

  const normalizedHostname = hostname.trim().toLowerCase().replace(/\.$/, '');
  const withoutSuffix = normalizedHostname.endsWith('.service-now.com')
    ? normalizedHostname.slice(0, -'.service-now.com'.length)
    : normalizedHostname;

  if (!withoutSuffix || withoutSuffix.includes('.') || !SINGLE_LABEL_INSTANCE_REGEX.test(withoutSuffix)) {
    return undefined;
  }
  return withoutSuffix;
}

// Initialize instance from env on module load
instance = normalizeServiceNowInstanceInput(process.env.SERVICENOW_INSTANCE) || '';

/**
 * Returns the current ServiceNow instance name (subdomain label).
 */
export function getInstance(): string {
  return instance;
}

/**
 * Returns the current ServiceNow username.
 */
export function getUsername(): string {
  return username;
}

/**
 * Returns the current ServiceNow password.
 */
export function getPassword(): string {
  return password;
}

/**
 * Returns true if all three credentials are configured.
 */
export function isConfigured(): boolean {
  return instance.length > 0 && username.length > 0 && password.length > 0;
}

/**
 * Update credentials at runtime (e.g. after configure_servicenow).
 */
export function setCredentials(inst: string, user: string, pass: string): void {
  instance = inst;
  username = user;
  password = pass;
}
