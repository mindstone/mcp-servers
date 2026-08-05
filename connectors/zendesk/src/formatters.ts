import type {
  FormatOptions,
  ZendeskTicket,
  ZendeskComment,
  ZendeskUser,
  ZendeskGroup,
  ZendeskTicketField,
  ZendeskMacro,
  ZendeskOrganization,
  ZendeskHelpCenterArticle,
  ZendeskSatisfactionRating,
} from './types.js';
import { wrapUntrusted } from './untrusted-content.js';

// ---------------------------------------------------------------------------
// Untrusted-content envelope helpers (M3.5b)
//
// Body content returned by Zendesk (ticket subjects/descriptions, comment
// bodies, user names, organisation names, macro titles) is third-party text
// that an end-user or external requester wrote. We wrap it in
// <untrusted-content source="...">...</untrusted-content> so the host LLM can
// recognise it as data, not instructions. Connector-controlled metadata
// (ids, statuses, priorities, requester ids, timestamps) is NEVER wrapped.
//
// All wrapping delegates to the canonical envelope helper in
// `src/untrusted-content.ts` (vendored from connectors/_template, per
// AGENTS.md security invariant #6) — the close-tag breakout escaping lives
// there and must not be re-implemented here.
// ---------------------------------------------------------------------------

export const UNTRUSTED_TICKET_SOURCE = 'external-ticket';
export const UNTRUSTED_USER_SOURCE = 'external-user';
export const UNTRUSTED_ORG_SOURCE = 'external-organization';
export const UNTRUSTED_MACRO_SOURCE = 'external-macro';
export const UNTRUSTED_ARTICLE_SOURCE = 'external-help-center';
export const UNTRUSTED_SATISFACTION_SOURCE = 'external-satisfaction-rating';

export const UNTRUSTED_TICKET_OPEN = `<untrusted-content source="${UNTRUSTED_TICKET_SOURCE}">`;
export const UNTRUSTED_TICKET_CLOSE = '</untrusted-content>';

/**
 * Wrap a body string in the external-ticket envelope. Returns `undefined`
 * for null/undefined/non-string/empty input so callers can skip the field
 * entirely rather than emit an empty envelope.
 *
 * Any `</untrusted-content>` (and case / whitespace variants) embedded in
 * `s` is rewritten to a benign textual form by the canonical helper, so an
 * attacker controlling ticket content cannot break out of the envelope.
 * Idempotent for the same source: `wrap(wrap(s)) === wrap(s)`.
 */
export function wrapUntrustedTicketContent(s: string | null | undefined): string | undefined {
  if (typeof s !== 'string' || s.length === 0) return undefined;
  return wrapUntrusted(s, UNTRUSTED_TICKET_SOURCE);
}

/**
 * Return a shallow clone of the ticket with the attacker-controlled text
 * fields wrapped: `subject` (end-users set subjects, e.g. via email) and
 * `description`. Metadata (id, status, priority, requester_id, timestamps,
 * tags...) is left untouched.
 */
export function wrapTicketBodyFields(ticket: ZendeskTicket): ZendeskTicket {
  const wrapped: ZendeskTicket = { ...ticket };
  const ws = wrapUntrustedTicketContent(ticket.subject);
  if (ws !== undefined) wrapped.subject = ws;
  const wd = wrapUntrustedTicketContent(ticket.description);
  if (wd !== undefined) wrapped.description = wd;
  return wrapped;
}

/**
 * Return a shallow clone of the user with the user-authored text fields
 * wrapped: `name` and `email`. Role, ids, and timestamps are left untouched.
 */
export function wrapUserFields(user: ZendeskUser): ZendeskUser {
  const wrapped: ZendeskUser = { ...user };
  const wn = wrapUntrusted(user.name, UNTRUSTED_USER_SOURCE);
  if (wn !== undefined) wrapped.name = wn;
  const we = wrapUntrusted(user.email, UNTRUSTED_USER_SOURCE);
  if (we !== undefined) wrapped.email = we;
  return wrapped;
}

/**
 * Return a shallow clone of the organization with the externally-authored
 * text fields wrapped: `name`, `details`, and `notes`.
 */
export function wrapOrganizationFields(org: ZendeskOrganization): ZendeskOrganization {
  const wrapped: ZendeskOrganization = { ...org };
  const wn = wrapUntrusted(org.name, UNTRUSTED_ORG_SOURCE);
  if (wn !== undefined) wrapped.name = wn;
  const wd = wrapUntrusted(org.details, UNTRUSTED_ORG_SOURCE);
  if (wd !== undefined) wrapped.details = wd;
  const wno = wrapUntrusted(org.notes, UNTRUSTED_ORG_SOURCE);
  if (wno !== undefined) wrapped.notes = wno;
  return wrapped;
}

/**
 * Return a shallow clone of the macro with the admin-authored `title` and
 * `description` wrapped. Action values are left untouched (they are
 * structured field updates authored by admins, not end-user text).
 */
export function wrapMacroFields(macro: ZendeskMacro): ZendeskMacro {
  const wrapped: ZendeskMacro = { ...macro };
  const wt = wrapUntrusted(macro.title, UNTRUSTED_MACRO_SOURCE);
  if (wt !== undefined) wrapped.title = wt;
  const wd = wrapUntrusted(macro.description ?? undefined, UNTRUSTED_MACRO_SOURCE);
  if (wd !== undefined) wrapped.description = wd;
  return wrapped;
}

/**
 * Return a shallow clone of the Help Center article with the externally
 * authored text fields wrapped: `title`, `body`, and `snippet`.
 */
export function wrapArticleFields(article: ZendeskHelpCenterArticle): ZendeskHelpCenterArticle {
  const wrapped: ZendeskHelpCenterArticle = { ...article };
  const wt = wrapUntrusted(article.title, UNTRUSTED_ARTICLE_SOURCE);
  if (wt !== undefined) wrapped.title = wt;
  const wb = wrapUntrusted(article.body, UNTRUSTED_ARTICLE_SOURCE);
  if (wb !== undefined) wrapped.body = wb;
  const ws = wrapUntrusted(article.snippet, UNTRUSTED_ARTICLE_SOURCE);
  if (ws !== undefined) wrapped.snippet = ws;
  return wrapped;
}

/**
 * Return a shallow clone of the satisfaction rating with the end-user-authored
 * `comment` wrapped. Scores, ids, and timestamps are left untouched.
 */
export function wrapSatisfactionRatingFields(rating: ZendeskSatisfactionRating): ZendeskSatisfactionRating {
  const wrapped: ZendeskSatisfactionRating = { ...rating };
  if (typeof rating.comment === 'string' && rating.comment.length > 0) {
    const wc = wrapUntrusted(rating.comment, UNTRUSTED_SATISFACTION_SOURCE);
    if (wc !== undefined) wrapped.comment = wc;
  }
  return wrapped;
}

/**
 * Return a shallow clone of the comment with body fields wrapped. Wraps
 * `body`, and (when present) the optional `html_body` / `plain_body`
 * fields the Zendesk REST API may return for HTML/plain renderings.
 */
export function wrapCommentBodyFields<
  T extends ZendeskComment & { html_body?: string | null; plain_body?: string | null }
>(comment: T): T {
  const wrapped: T = { ...comment };
  const wb = wrapUntrustedTicketContent(comment.body);
  if (wb !== undefined) wrapped.body = wb;
  const maybeHtml = (comment as { html_body?: string | null }).html_body;
  if (maybeHtml !== undefined) {
    const wh = wrapUntrustedTicketContent(maybeHtml);
    if (wh !== undefined) {
      (wrapped as { html_body?: string }).html_body = wh;
    }
  }
  const maybePlain = (comment as { plain_body?: string | null }).plain_body;
  if (maybePlain !== undefined) {
    const wp = wrapUntrustedTicketContent(maybePlain);
    if (wp !== undefined) {
      (wrapped as { plain_body?: string }).plain_body = wp;
    }
  }
  return wrapped;
}

export function formatTicket(ticket: ZendeskTicket, options: FormatOptions = {}): string {
  const format = options.format || 'concise';

  if (format === 'concise') {
    return `#${ticket.id}: ${ticket.subject} [${ticket.status}] (${ticket.priority || 'no priority'})`;
  }

  return [
    `Ticket #${ticket.id}`,
    `Subject: ${ticket.subject}`,
    `Status: ${ticket.status}`,
    `Priority: ${ticket.priority || 'none'}`,
    `Type: ${ticket.type || 'none'}`,
    `Requester ID: ${ticket.requester_id}`,
    `Assignee ID: ${ticket.assignee_id || 'unassigned'}`,
    `Group ID: ${ticket.group_id || 'none'}`,
    `Created: ${ticket.created_at}`,
    `Updated: ${ticket.updated_at}`,
    ticket.description ? `Description:\n${ticket.description}` : '',
  ].filter(Boolean).join('\n');
}

export function formatUser(user: ZendeskUser, options: FormatOptions = {}): string {
  const format = options.format || 'concise';

  if (format === 'concise') {
    return `${user.name} <${user.email}> (ID: ${user.id}, ${user.role})`;
  }

  return [
    `User ID: ${user.id}`,
    `Name: ${user.name}`,
    `Email: ${user.email}`,
    `Role: ${user.role}`,
    `Active: ${user.active}`,
    `Created: ${user.created_at}`,
    user.phone ? `Phone: ${user.phone}` : '',
    user.organization_id ? `Organization ID: ${user.organization_id}` : '',
  ].filter(Boolean).join('\n');
}

export function formatGroup(group: ZendeskGroup): string {
  return `${group.name} (ID: ${group.id})`;
}

export function formatTicketField(field: ZendeskTicketField): string {
  const required = field.required ? ' [required]' : '';
  return `${field.title} (ID: ${field.id}, type: ${field.type})${required}`;
}

export function formatMacro(macro: ZendeskMacro, options: FormatOptions = {}): string {
  const format = options.format || 'concise';
  const status = macro.active ? 'active' : 'inactive';

  if (format === 'concise') {
    const actionSummary = macro.actions.map(a => `${a.field}:${typeof a.value === 'string' ? a.value : JSON.stringify(a.value)}`).join(', ');
    return `${macro.title} (ID: ${macro.id}, ${status}) — actions: ${actionSummary}`;
  }

  return [
    `Macro #${macro.id}`,
    `Title: ${macro.title}`,
    macro.description ? `Description: ${macro.description}` : '',
    `Active: ${macro.active}`,
    `Actions:`,
    ...macro.actions.map(a => `  - ${a.field}: ${JSON.stringify(a.value)}`),
    macro.restriction ? `Restriction: ${macro.restriction.type}${macro.restriction.id ? ` (ID: ${macro.restriction.id})` : ''}` : '',
    `Created: ${macro.created_at}`,
    `Updated: ${macro.updated_at}`,
  ].filter(Boolean).join('\n');
}
