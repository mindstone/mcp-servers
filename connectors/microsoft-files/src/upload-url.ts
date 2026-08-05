import { FilesBusinessError } from './types.js';

/**
 * Resumable-upload destination policy.
 *
 * `createUploadSession` returns a preauthenticated `uploadUrl` and chunk PUTs
 * go to it WITHOUT the Graph bearer token — so the URL is the only thing
 * deciding where user file bytes are sent. A malicious or compromised upstream
 * response must not be able to point the connector at an arbitrary network
 * destination (SSRF): the URL is accepted only when it is HTTPS on the default
 * port, carries no userinfo, and sits on a Microsoft OneDrive/SharePoint host.
 *
 * The host allow-list also covers the private/loopback/link-local/metadata-
 * service cases: IP literals and non-vendor hostnames simply never match the
 * suffixes below, so they are rejected without a separate address check. DNS
 * rebinding is not a practical concern here because an attacker cannot obtain
 * a hostname under these vendor suffixes.
 *
 * Redirects are rejected at the fetch layer (`redirect: 'error'`) rather than
 * followed, so no redirect hop can smuggle the bytes to a different host.
 */

const ALLOWED_UPLOAD_HOST_SUFFIXES = [
  // OneDrive for Business / SharePoint-backed drives, incl. <tenant>-my.
  '.sharepoint.com',
  // Personal OneDrive upload sessions (e.g. api.onedrive.com).
  '.onedrive.com',
  // OneDrive consumer download/upload edge hosts.
  '.1drv.com',
];

export function isAllowedUploadHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return ALLOWED_UPLOAD_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Validate a Graph-supplied upload-session URL. Returns the parsed URL when it
 * satisfies the policy; throws FilesBusinessError (fail-closed, with explicit
 * guidance) otherwise. No network I/O happens before this check passes.
 */
export function validateUploadSessionUrl(input: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new FilesBusinessError(
      'The upload session URL returned by Microsoft Graph is not a valid URL.',
      'upload_file',
    );
  }

  if (parsed.protocol !== 'https:') {
    throw new FilesBusinessError(
      `Refusing non-HTTPS upload session URL (${parsed.protocol.replace(/:$/, '')}).`,
      'upload_file',
    );
  }

  if (parsed.username || parsed.password) {
    throw new FilesBusinessError(
      'Refusing upload session URL containing userinfo (user:pass@host).',
      'upload_file',
    );
  }

  if (parsed.port !== '') {
    throw new FilesBusinessError(
      `Refusing upload session URL on a non-default port (${parsed.port}).`,
      'upload_file',
    );
  }

  if (!isAllowedUploadHost(parsed.hostname)) {
    throw new FilesBusinessError(
      'Refusing upload session URL: host is not a Microsoft OneDrive/SharePoint host. Upload chunks are only sent to vendor hosts.',
      'upload_file',
    );
  }

  return parsed;
}
