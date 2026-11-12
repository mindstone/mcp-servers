/**
 * Building Things URL-scheme commands, as a closed set: only `json` (create) and `update` can be
 * produced (`update-project` for a project's status), and only with parameters the writer fills in, so nothing can smuggle in `duplicate`,
 * `use-clipboard`, a batch or a raw URL. Spec: https://culturedcode.com/things/support/articles/2803573/
 */

/** Where a to-do goes in time: today, evening, tomorrow, anytime, someday, or a date `YYYY-MM-DD`. */
export type When = 'today' | 'evening' | 'tomorrow' | 'anytime' | 'someday' | string;

/** Things' own limits (URL scheme docs). */
export const LIMITS = { title: 4000, notes: 10000, checklist: 100 } as const;

/**
 * Percent-encode every value (`%20` for a space, never `+`, which Things would keep literally),
 * dropping undefined ones. An empty string is kept: it clears a field (`deadline=`).
 */
export function thingsUrl(command: 'json' | 'update' | 'update-project', params: Record<string, string | undefined>): string {
  const query = Object.entries(params)
    .filter((e): e is [string, string] => e[1] !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  return `things:///${command}?${query}`;
}

/**
 * Replace the auth token wherever it appears, for errors and logs: the given token (raw or
 * URL-encoded), and any `auth-token=` value whatever it is (an `'` included, which
 * encodeURIComponent leaves alone).
 */
export function redact(text: string, token?: string): string {
  const out = token ? text.split(encodeURIComponent(token)).join('<token>').split(token).join('<token>') : text;
  return out.replace(/(auth-token(?:=|%3D))[^&\s"]+/gi, '$1<token>');
}
