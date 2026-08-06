import { FilesBusinessError } from './types.js';

/**
 * Vendor-destination policy for pre-authenticated file-byte traffic.
 *
 * Two Graph flows hand the connector a URL from an upstream response and the
 * connector then sends or receives user file bytes at that URL:
 *
 *  1. `createUploadSession` returns a preauthenticated `uploadUrl` and chunk
 *     PUTs go to it WITHOUT the Graph bearer token — so the URL is the only
 *     thing deciding where user file bytes are sent.
 *  2. `GET .../content` answers with a 302 to a short-lived pre-authenticated
 *     download URL; redirects are followed manually so every hop is
 *     revalidated here before the connector fetches it.
 *
 * In both cases a malicious or compromised upstream response must not be able
 * to point the connector at an arbitrary network destination (SSRF): the URL
 * is accepted only when it is HTTPS on the default port, carries no userinfo,
 * and sits on a Microsoft OneDrive/SharePoint host (redirect hops may also
 * stay on the Graph host itself).
 *
 * The host allow-list also covers the private/loopback/link-local/metadata-
 * service cases: IP literals and non-vendor hostnames simply never match the
 * suffixes below, so they are rejected without a separate address check. DNS
 * rebinding is not a practical concern here because an attacker cannot obtain
 * a hostname under these vendor suffixes.
 */

const ALLOWED_UPLOAD_HOST_SUFFIXES = [
  // OneDrive for Business / SharePoint-backed drives, incl. <tenant>-my.
  '.sharepoint.com',
  // Personal OneDrive upload sessions (e.g. api.onedrive.com).
  '.onedrive.com',
  // OneDrive consumer download/upload edge hosts.
  '.1drv.com',
];

// The Graph host itself: first-hop requests and same-host redirect hops.
const GRAPH_HOSTNAME = 'graph.microsoft.com';

export function isAllowedUploadHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return ALLOWED_UPLOAD_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Shared shape checks: HTTPS on the default port, no userinfo. Throws
 * FilesBusinessError (fail-closed, with explicit guidance); no network I/O
 * happens before these checks pass.
 */
function assertVendorUrlShape(parsed: URL, kind: string, nextStep: string): void {
  if (parsed.protocol !== 'https:') {
    throw new FilesBusinessError(
      `Refusing non-HTTPS ${kind} (${parsed.protocol.replace(/:$/, '')}).`,
      nextStep,
    );
  }
  if (parsed.username || parsed.password) {
    throw new FilesBusinessError(
      `Refusing ${kind} containing userinfo (user:pass@host).`,
      nextStep,
    );
  }
  if (parsed.port !== '') {
    throw new FilesBusinessError(
      `Refusing ${kind} on a non-default port (${parsed.port}).`,
      nextStep,
    );
  }
}

function parseUrl(input: string, kind: string, nextStep: string): URL {
  try {
    return new URL(input);
  } catch {
    throw new FilesBusinessError(`The ${kind} is not a valid URL.`, nextStep);
  }
}

/**
 * Validate a Graph-supplied upload-session URL. Returns the parsed URL when it
 * satisfies the policy; throws FilesBusinessError otherwise.
 */
export function validateUploadSessionUrl(input: string): URL {
  const parsed = parseUrl(input, 'upload session URL returned by Microsoft Graph', 'upload_file');
  assertVendorUrlShape(parsed, 'upload session URL', 'upload_file');
  if (!isAllowedUploadHost(parsed.hostname)) {
    throw new FilesBusinessError(
      'Refusing upload session URL: host is not a Microsoft OneDrive/SharePoint host. Upload chunks are only sent to vendor hosts.',
      'upload_file',
    );
  }
  return parsed;
}

/**
 * Validate a redirect hop from a drive-item content download. Same vendor
 * policy as upload sessions, plus hops that stay on the Graph host itself.
 * Anything else fails closed: the redirect is refused (observable error), not
 * silently followed.
 */
export function validateContentRedirectUrl(input: string): URL {
  const parsed = parseUrl(input, 'download redirect URL', 'read_document');
  assertVendorUrlShape(parsed, 'download redirect URL', 'read_document');
  if (parsed.hostname !== GRAPH_HOSTNAME && !isAllowedUploadHost(parsed.hostname)) {
    throw new FilesBusinessError(
      'Refusing download redirect: host is not a Microsoft OneDrive/SharePoint host. Document content is only fetched from vendor hosts.',
      'read_document',
    );
  }
  return parsed;
}
