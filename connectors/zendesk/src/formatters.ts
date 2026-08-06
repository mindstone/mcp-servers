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
  ZendeskView,
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
export const UNTRUSTED_GROUP_SOURCE = 'external-group';
export const UNTRUSTED_TICKET_FIELD_SOURCE = 'external-ticket-field';
export const UNTRUSTED_VIEW_SOURCE = 'external-view';

export const UNTRUSTED_TICKET_OPEN = `<untrusted-content source="${UNTRUSTED_TICKET_SOURCE}">`;
export const UNTRUSTED_TICKET_CLOSE = '</untrusted-content>';

const KNOWN_TICKET_STATUSES = new Set(['new', 'open', 'pending', 'hold', 'solved', 'closed']);

/**
 * Render a ticket status for model-visible output. `zendeskFetch<T>` is an
 * unchecked cast — the TypeScript enum on `ZendeskTicket.status` carries no
 * runtime guarantee — so a vendor/proxy-controlled value could be any string
 * (or a non-string) and would otherwise be rendered unenveloped. Fail closed
 * to a static placeholder unless the value is a documented Zendesk status.
 */
export function safeTicketStatus(status: unknown): string {
  return typeof status === 'string' && KNOWN_TICKET_STATUSES.has(status) ? status : 'unknown';
}

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
 * fields wrapped: `subject` (end-users set subjects, e.g. via email),
 * `description`, `tags`, and string-valued `custom_fields` values. Ids,
 * statuses, priorities, requester ids, and timestamps are left untouched.
 */
export function wrapTicketBodyFields(ticket: ZendeskTicket): ZendeskTicket {
  const wrapped: ZendeskTicket = { ...ticket };
  const ws = wrapUntrustedTicketContent(ticket.subject);
  if (ws !== undefined) wrapped.subject = ws;
  const wd = wrapUntrustedTicketContent(ticket.description);
  if (wd !== undefined) wrapped.description = wd;
  if (Array.isArray(ticket.tags)) {
    wrapped.tags = ticket.tags.map(t => wrapUntrusted(t, UNTRUSTED_TICKET_SOURCE) ?? t);
  }
  if (Array.isArray(ticket.custom_fields)) {
    wrapped.custom_fields = ticket.custom_fields.map(cf =>
      typeof cf.value === 'string'
        ? { ...cf, value: wrapUntrusted(cf.value, UNTRUSTED_TICKET_SOURCE) ?? cf.value }
        : cf,
    );
  }
  return wrapped;
}

/**
 * Return a shallow clone of the user with the user-authored text fields
 * wrapped: `name`, `email`, and `phone`. Role, ids, and timestamps are left
 * untouched.
 */
export function wrapUserFields(user: ZendeskUser): ZendeskUser {
  const wrapped: ZendeskUser = { ...user };
  const wn = wrapUntrusted(user.name, UNTRUSTED_USER_SOURCE);
  if (wn !== undefined) wrapped.name = wn;
  const we = wrapUntrusted(user.email, UNTRUSTED_USER_SOURCE);
  if (we !== undefined) wrapped.email = we;
  const wp = wrapUntrusted(user.phone, UNTRUSTED_USER_SOURCE);
  if (wp !== undefined) wrapped.phone = wp;
  return wrapped;
}

/**
 * Return a shallow clone of the organization with the externally-authored
 * text fields wrapped: `name`, `details`, `notes`, and `domain_names`.
 */
export function wrapOrganizationFields(org: ZendeskOrganization): ZendeskOrganization {
  const wrapped: ZendeskOrganization = { ...org };
  const wn = wrapUntrusted(org.name, UNTRUSTED_ORG_SOURCE);
  if (wn !== undefined) wrapped.name = wn;
  const wd = wrapUntrusted(org.details, UNTRUSTED_ORG_SOURCE);
  if (wd !== undefined) wrapped.details = wd;
  const wno = wrapUntrusted(org.notes, UNTRUSTED_ORG_SOURCE);
  if (wno !== undefined) wrapped.notes = wno;
  if (Array.isArray(org.domain_names)) {
    wrapped.domain_names = org.domain_names.map(d => wrapUntrusted(d, UNTRUSTED_ORG_SOURCE) ?? d);
  }
  return wrapped;
}

/**
 * Return a shallow clone of the group with the externally-authored `name`
 * and `description` wrapped. Group names are authored in Zendesk admin and
 * are not connector-controlled.
 */
export function wrapGroupFields(group: ZendeskGroup): ZendeskGroup {
  const wrapped: ZendeskGroup = { ...group };
  const wn = wrapUntrusted(group.name, UNTRUSTED_GROUP_SOURCE);
  if (wn !== undefined) wrapped.name = wn;
  const wd = wrapUntrusted(group.description, UNTRUSTED_GROUP_SOURCE);
  if (wd !== undefined) wrapped.description = wd;
  return wrapped;
}

/**
 * Return a shallow clone of the ticket field with the externally-authored
 * `title`, `description`, and custom option names/values wrapped.
 */
export function wrapTicketFieldFields(field: ZendeskTicketField): ZendeskTicketField {
  const wrapped: ZendeskTicketField = { ...field };
  const wt = wrapUntrusted(field.title, UNTRUSTED_TICKET_FIELD_SOURCE);
  if (wt !== undefined) wrapped.title = wt;
  const wd = wrapUntrusted(field.description, UNTRUSTED_TICKET_FIELD_SOURCE);
  if (wd !== undefined) wrapped.description = wd;
  if (Array.isArray(field.custom_field_options)) {
    wrapped.custom_field_options = field.custom_field_options.map(opt => ({
      ...opt,
      name: wrapUntrusted(opt.name, UNTRUSTED_TICKET_FIELD_SOURCE) ?? opt.name,
      value: wrapUntrusted(opt.value, UNTRUSTED_TICKET_FIELD_SOURCE) ?? opt.value,
    }));
  }
  return wrapped;
}

/**
 * Return a shallow clone of the view with the externally-authored `title`
 * wrapped.
 */
export function wrapViewFields(view: ZendeskView): ZendeskView {
  const wrapped: ZendeskView = { ...view };
  const wt = wrapUntrusted(view.title, UNTRUSTED_VIEW_SOURCE);
  if (wt !== undefined) wrapped.title = wt;
  return wrapped;
}

/**
 * Return a shallow clone of the macro with the admin-authored `title`,
 * `description`, and action values wrapped. Action values include free-form
 * strings (e.g. `comment_value`) authored by Zendesk admins — they are
 * external content, not connector-controlled structure.
 */
export function wrapMacroFields(macro: ZendeskMacro): ZendeskMacro {
  const wrapped: ZendeskMacro = { ...macro };
  const wt = wrapUntrusted(macro.title, UNTRUSTED_MACRO_SOURCE);
  if (wt !== undefined) wrapped.title = wt;
  const wd = wrapUntrusted(macro.description ?? undefined, UNTRUSTED_MACRO_SOURCE);
  if (wd !== undefined) wrapped.description = wd;
  if (Array.isArray(macro.actions)) {
    wrapped.actions = macro.actions.map(action => {
      if (typeof action.value === 'string') {
        return { ...action, value: wrapUntrusted(action.value, UNTRUSTED_MACRO_SOURCE) ?? action.value };
      }
      if (Array.isArray(action.value)) {
        return {
          ...action,
          value: action.value.map(v => wrapUntrusted(v, UNTRUSTED_MACRO_SOURCE) ?? v),
        };
      }
      return action;
    });
  }
  return wrapped;
}

/**
 * Return a shallow clone of the Help Center article with the externally
 * authored text fields wrapped: `title`, `body`, `snippet`, and `html_url`.
 */
export function wrapArticleFields(article: ZendeskHelpCenterArticle): ZendeskHelpCenterArticle {
  const wrapped: ZendeskHelpCenterArticle = { ...article };
  const wt = wrapUntrusted(article.title, UNTRUSTED_ARTICLE_SOURCE);
  if (wt !== undefined) wrapped.title = wt;
  const wb = wrapUntrusted(article.body, UNTRUSTED_ARTICLE_SOURCE);
  if (wb !== undefined) wrapped.body = wb;
  const ws = wrapUntrusted(article.snippet, UNTRUSTED_ARTICLE_SOURCE);
  if (ws !== undefined) wrapped.snippet = ws;
  const wu = wrapUntrusted(article.html_url, UNTRUSTED_ARTICLE_SOURCE);
  if (wu !== undefined) wrapped.html_url = wu;
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
  const status = safeTicketStatus(ticket.status);

  if (format === 'concise') {
    return `#${ticket.id}: ${ticket.subject} [${status}] (${ticket.priority || 'no priority'})`;
  }

  return [
    `Ticket #${ticket.id}`,
    `Subject: ${ticket.subject}`,
    `Status: ${status}`,
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
