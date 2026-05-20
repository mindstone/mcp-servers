/**
 * AGENTS.md security invariant #6: content fetched from external systems
 * MUST be wrapped in `<untrusted-content source="…">…</untrusted-content>`
 * envelopes before being returned to the LLM, with close-tag breakout
 * escaping so an attacker cannot terminate the envelope from within their
 * own message.
 *
 * Slack-specific call sites:
 *   - message `text` returned by conversations.history / search.messages /
 *     conversations.replies / im.history / get_slack_message
 *   - channel topic / purpose / name returned by conversations.info
 *   - file `title` / `name` / `pretty_type` returned by files.info
 *
 * The wrappers below are the only authorized way to surface those strings
 * inside tool responses. They live in this module (not utils.ts) so a
 * grep audit can easily verify the envelope helper is reached at every
 * external-text boundary.
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
