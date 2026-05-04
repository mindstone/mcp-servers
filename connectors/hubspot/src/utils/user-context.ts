import { getHubSpotClientAsync } from '../api/hubspot-client.js';
import { getAccountManager } from '../modules/accounts/manager.js';
import logger from './logger.js';

const OWNER_LOOKUP_TIMEOUT_MS = 3000;

const SOURCE_DETAIL_SUPPORTED_TYPES = new Set([
  'contacts', 'companies', 'deals', 'tickets', 'tasks', 'products'
]);

interface OwnerInfo {
  ownerId: string;
  fullName: string;
  email: string;
}

const ownerCache = new Map<string, Promise<OwnerInfo | null>>();

async function lookupOwnerByEmail(email: string): Promise<OwnerInfo | null> {
  const client = await getHubSpotClientAsync();
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('Owner lookup timed out')), OWNER_LOOKUP_TIMEOUT_MS);
  });
  const lookupPromise = client.listOwners(1, undefined, email);
  const result = await Promise.race([lookupPromise, timeoutPromise]);

  if (!result.results || result.results.length === 0) return null;

  const owner = result.results[0];
  const firstName = owner.firstName || '';
  const lastName = owner.lastName || '';
  const fullName = [firstName, lastName].filter(Boolean).join(' ');

  return {
    ownerId: owner.id,
    fullName,
    email: owner.email
  };
}

async function getCurrentUserOwnerInfo(): Promise<OwnerInfo | null> {
  const email = await getAccountManager().getCurrentAccountEmail();
  if (!email) return null;

  if (!ownerCache.has(email)) {
    const promise = lookupOwnerByEmail(email).catch((error) => {
      ownerCache.delete(email);
      logger.debug('Owner lookup failed, will retry next time:', error);
      return null;
    });
    ownerCache.set(email, promise);
  }
  return ownerCache.get(email)!;
}

function getSourceDetailString(ownerInfo: OwnerInfo | null, email: string): string {
  if (ownerInfo && ownerInfo.fullName) {
    return `Created by ${ownerInfo.fullName} via Rebel`;
  }
  return `Created by ${email} via Rebel`;
}

export async function injectRebelMetadata(
  properties: Record<string, string> | null | undefined,
  objectType: string
): Promise<Record<string, string>> {
  const safeProps = { ...(properties ?? {}) };
  try {
    const needsSourceDetail = SOURCE_DETAIL_SUPPORTED_TYPES.has(objectType);
    const needsOwner = objectType === 'deals';

    if (!needsSourceDetail && !needsOwner) return safeProps;

    const hasSourceDetail = !!safeProps.hs_object_source_detail_2;
    const hasOwner = !!safeProps.hubspot_owner_id;
    if ((hasSourceDetail || !needsSourceDetail) && (hasOwner || !needsOwner)) return safeProps;

    const ownerInfo = await getCurrentUserOwnerInfo();
    const email = await getAccountManager().getCurrentAccountEmail();

    if (needsSourceDetail && !hasSourceDetail) {
      safeProps.hs_object_source_detail_2 = getSourceDetailString(ownerInfo, email);
    }

    if (needsOwner && !hasOwner && ownerInfo) {
      safeProps.hubspot_owner_id = ownerInfo.ownerId;
    }

    return safeProps;
  } catch (error) {
    logger.debug(`Rebel metadata injection skipped (${objectType}):`, error);
    return safeProps;
  }
}

export function clearOwnerCache(): void {
  ownerCache.clear();
}
