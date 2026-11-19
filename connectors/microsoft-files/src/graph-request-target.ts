/**
 * Request-target helpers for Microsoft Graph URLs.
 *
 * Vendored byte-identical into microsoft-mail, microsoft-files,
 * microsoft-teams and microsoft-sharepoint; change every copy together.
 *
 * The Graph JS SDK neither encodes nor checks the path passed to
 * `client.api()`, nor the strings passed to `.filter()` / `.search()`, so a
 * model-supplied value placed raw into a request becomes URL structure: `/`
 * and `..` move the request to another Graph resource under the same token,
 * `?` / `#` / `&` add or cut query parameters, and a `'` closes an OData
 * string literal. Every model-supplied ID, path or query value goes through
 * one of these helpers before it reaches a Graph URL.
 *
 * Graph decodes each path segment once, so one `encodeURIComponent` per
 * segment is the form it expects. `encodeURIComponent` leaves `.` alone, so
 * `.` / `..` segments are refused rather than encoded.
 *
 * Refusal messages name the field and the rejected character classes, never
 * the value: they reach model-visible output.
 */

type TargetKind = 'id' | 'user' | 'drivePath' | 'siteId';

const REFUSED_CLASSES: Record<TargetKind, string> = {
  id: "Values containing '?', '#', '%', '\\', control characters, or '.'/'..' path segments are refused.",
  user: "Values containing '/', '?', '%', '\\', control characters, or '.'/'..' segments are refused.",
  drivePath: "Paths containing '\\', control characters, or '.'/'..' segments are refused.",
  siteId:
    "Pass a site ID as returned by a list tool (hostname,siteCollectionId,webId) or as hostname:/server-relative-path. Values containing '?', '#', '%', '\\', control characters, or '.'/'..' path segments are refused.",
};

const ACTION_REQUIRED: Record<TargetKind, (nextStep: string) => string> = {
  id: (nextStep) =>
    `Pass the ID exactly as ${nextStep} returned it (do not edit, decode or build it by hand), then retry.`,
  user: (nextStep) =>
    `Pass the user ID, user principal name or email address exactly as ${nextStep} returned it, then retry.`,
  drivePath: () =>
    'Pass a plain path of folder and file names separated by "/" (for example /Documents/Report.docx), then retry.',
  siteId: (nextStep) =>
    `Pass the site ID exactly as ${nextStep} returned it, or as hostname:/sites/name, then retry.`,
};

export class GraphRequestTargetError extends Error {
  readonly field: string;
  readonly nextStep: string;
  readonly actionRequired: string;

  constructor(kind: TargetKind, field: string, nextStep: string) {
    super(`Invalid "${field}". ${REFUSED_CLASSES[kind]}`);
    this.name = 'GraphRequestTargetError';
    this.field = field;
    this.nextStep = nextStep;
    this.actionRequired = ACTION_REQUIRED[kind](nextStep);
  }
}

// C0 controls and DEL. An ordinary space is allowed (SharePoint list titles,
// file names) and is sent as %20.
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
const ID_FORBIDDEN = /[?#%\\]/;
const USER_FORBIDDEN = /[/?%\\]/;
const HOSTNAME =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

function hasDotSegment(value: string): boolean {
  return value.split('/').some((segment) => segment === '.' || segment === '..');
}

function checkedString(value: unknown, kind: TargetKind, field: string, nextStep: string): string {
  if (typeof value !== 'string' || value.length === 0 || CONTROL_CHARS.test(value)) {
    throw new GraphRequestTargetError(kind, field, nextStep);
  }
  return value;
}

/**
 * One Graph ID as a single, encoded path segment. Real Graph IDs (base64-ish
 * with `/`, `+`, `=`; GUIDs; `19:...@thread.v2`) pass and are sent
 * percent-encoded.
 */
export function graphIdSegment(value: unknown, field: string, nextStep: string): string {
  const id = checkedString(value, 'id', field, nextStep);
  if (ID_FORBIDDEN.test(id) || hasDotSegment(id)) {
    throw new GraphRequestTargetError('id', field, nextStep);
  }
  return encodeURIComponent(id);
}

/**
 * A user ID, user principal name or email address as one encoded path
 * segment. Like {@link graphIdSegment} but allows `#` (guest principal names
 * contain `#EXT#`, sent as `%23EXT%23`) and refuses `/`.
 */
export function graphUserSegment(value: unknown, field: string, nextStep: string): string {
  const user = checkedString(value, 'user', field, nextStep);
  if (USER_FORBIDDEN.test(user) || user === '.' || user === '..') {
    throw new GraphRequestTargetError('user', field, nextStep);
  }
  return encodeURIComponent(user);
}

/**
 * A drive path (`/Folder/File name.docx`) for `root:<path>:` addressing.
 * Empty segments are dropped (a leading or doubled `/` is harmless); `.` /
 * `..` segments, backslashes and control characters are refused; every other
 * character is encoded per segment, so `#`, `%`, `?` and `:` in a name are
 * sent as `%23`, `%25`, `%3F` and `%3A`. Returns `''` for the drive root,
 * otherwise `/seg/seg`; callers build `root:${path}:` plus any suffix.
 */
export function graphDrivePath(value: unknown, field: string, nextStep: string): string {
  if (typeof value !== 'string' || CONTROL_CHARS.test(value) || value.includes('\\')) {
    throw new GraphRequestTargetError('drivePath', field, nextStep);
  }
  const segments = value.split('/').filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new GraphRequestTargetError('drivePath', field, nextStep);
  }
  return segments.map((segment) => `/${encodeURIComponent(segment)}`).join('');
}

/**
 * A SharePoint site identifier for `/sites/{site-id}`. Accepts the opaque
 * forms Graph returns (`hostname,siteCollectionId,webId`, `root`, a bare
 * hostname), sent as one encoded segment, and the path form
 * `hostname:/server-relative-path[:]`, whose hostname must be a plain DNS
 * name and whose path segments are checked and encoded with `/` and `:`
 * kept. The path form always ends with `:` so further segments can follow.
 */
export function graphSiteId(value: unknown, field: string, nextStep: string): string {
  const site = checkedString(value, 'siteId', field, nextStep);
  const colon = site.indexOf(':');
  if (colon === -1) {
    if (ID_FORBIDDEN.test(site) || site.includes('/') || site === '.' || site === '..') {
      throw new GraphRequestTargetError('siteId', field, nextStep);
    }
    return encodeURIComponent(site);
  }
  const host = site.slice(0, colon);
  let rest = site.slice(colon + 1);
  if (rest.endsWith(':')) rest = rest.slice(0, -1);
  if (
    !HOSTNAME.test(host) ||
    !rest.startsWith('/') ||
    rest.includes(':') ||
    ID_FORBIDDEN.test(rest) ||
    hasDotSegment(rest)
  ) {
    throw new GraphRequestTargetError('siteId', field, nextStep);
  }
  const segments = rest.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    throw new GraphRequestTargetError('siteId', field, nextStep);
  }
  return `${host}:${segments.map((segment) => `/${encodeURIComponent(segment)}`).join('')}:`;
}

/**
 * An OData string literal, ready to place in a query string: single quotes
 * doubled on the decoded value, then the whole literal body percent-encoded
 * once. `encodeURIComponent` leaves `'` as is, which is safe once doubled;
 * a pre-encoded `%27` becomes `%2527` and stays literal text.
 */
export function odataStringLiteral(value: string): string {
  return `'${encodeURIComponent(value.replace(/'/g, "''"))}'`;
}

/**
 * A whole query-parameter value (a caller-written `$filter`, a `$search`
 * expression), percent-encoded once so it stays one parameter: `&`, `#`,
 * `?` and `=` inside it cannot add or cut query keys.
 */
export function graphQueryValue(value: string): string {
  return encodeURIComponent(value);
}
