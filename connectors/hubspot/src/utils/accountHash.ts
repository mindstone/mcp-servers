import crypto from 'node:crypto';
import logger from './logger.js';

export const MISSING_ACCOUNT_HASH_SALT = '[salt-missing]';
const SALT_HEX_PATTERN = /^[a-f0-9]{64}$/i;

let warnedAboutMissingSalt = false;
let warnedAboutMalformedSalt = false;

function getTelemetrySaltHex(): { saltHex: string | null; reason: 'salt-missing' | 'salt-malformed' | null } {
  const rawSalt = process.env.HUBSPOT_TELEMETRY_SALT?.trim();
  if (!rawSalt) {
    return { saltHex: null, reason: 'salt-missing' };
  }
  if (!SALT_HEX_PATTERN.test(rawSalt)) {
    return { saltHex: null, reason: 'salt-malformed' };
  }
  return { saltHex: rawSalt.toLowerCase(), reason: null };
}

export function deriveHubSpotAccountHash(email: string): string {
  const { saltHex, reason } = getTelemetrySaltHex();
  if (!saltHex) {
    if (reason === 'salt-missing' && !warnedAboutMissingSalt) {
      warnedAboutMissingSalt = true;
      logger.warn({ reason }, 'account_hash_degraded');
    }
    if (reason === 'salt-malformed' && !warnedAboutMalformedSalt) {
      warnedAboutMalformedSalt = true;
      logger.warn({ reason }, 'account_hash_degraded');
    }
    return MISSING_ACCOUNT_HASH_SALT;
  }

  return crypto
    .createHmac('sha256', Buffer.from(saltHex, 'hex'))
    .update(email.toLowerCase())
    .digest('hex');
}

export function __resetAccountHashWarningForTests(): void {
  warnedAboutMissingSalt = false;
  warnedAboutMalformedSalt = false;
}
