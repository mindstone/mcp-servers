/**
 * AGENTS.md security invariant #6: content fetched from external systems
 * MUST be wrapped in `<untrusted-content source="…">…</untrusted-content>`
 * envelopes before being returned to the LLM, with close-tag breakout
 * escaping so an attacker cannot terminate the envelope from within the
 * payload.
 *
 * Replit-SSH-specific call sites:
 *   - `replit_read_file` content (utf-8 + base64 branches)
 *   - `replit_list_files` directory entry names (file names on the remote
 *     are attacker-influenced)
 *   - `replit_search_files` matched paths and matched content lines
 *
 * The wrapper lives here (not in `ssh.ts`) so a grep audit can easily
 * verify the envelope helper is reached at every external-text boundary.
 */

function escapeAttr(s: string): string {
  return s.replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * Wrap a single untrusted string in an `<untrusted-content>` envelope.
 *
 * The string is encoded so a literal `</untrusted-content>` inside the
 * payload cannot terminate the envelope: each occurrence is rewritten to
 * `<&#47;untrusted-content>`, which is human-readable in tool transcripts
 * but no longer matches the wrapper's close tag.
 *
 * Pass `undefined` through untouched so callers can apply the wrapper
 * uniformly to optional fields without branching.
 */
export function wrapUntrusted(text: string | undefined, source: string): string | undefined {
  if (text === undefined) return undefined;
  const safe = text.replaceAll('</untrusted-content>', '<&#47;untrusted-content>');
  return `<untrusted-content source="${escapeAttr(source)}">${safe}</untrusted-content>`;
}
