/**
 * Response formatting helpers for Freshdesk API data.
 *
 * EVERY string returned by Freshdesk (ticket subjects/descriptions, tags,
 * emails, phone numbers, company domains, custom-field keys/values, ticket-
 * field metadata, KB article content, …) is third-party text that an end-user
 * or external requester may have written. It is wrapped in
 * `<untrusted-content source="…">…</untrusted-content>` envelopes via the
 * canonical shared helper (vendored at `./untrusted-content.ts`) so the host
 * LLM treats it as data, not instructions. Only non-string connector metadata
 * (numeric ids, statuses, priorities) is left untouched.
 */

import type {
  FreshdeskTicket,
  FreshdeskConversation,
  FreshdeskTicketField,
  FreshdeskAgent,
  FreshdeskGroup,
  FreshdeskContact,
  FreshdeskCompany,
  FreshdeskSolutionArticle,
} from './types.js';
import { statusToString, priorityToString, sourceToString } from './types.js';
import { wrapUntrusted, wrapUntrustedJsonStrings } from './untrusted-content.js';

export const UNTRUSTED_TICKET_OPEN = '<untrusted-content source="external-ticket">';
export const UNTRUSTED_TICKET_CLOSE = '</untrusted-content>';

const TICKET_SOURCE = 'external-ticket';
const AGENT_SOURCE = 'external-agent';
const GROUP_SOURCE = 'external-group';
const CONTACT_SOURCE = 'external-contact';
const COMPANY_SOURCE = 'external-company';
const ARTICLE_SOURCE = 'external-kb-article';
const FIELD_SOURCE = 'external-ticket-field';

/**
 * Wrap an optional external-text field in an `<untrusted-content>` envelope.
 * Returns `undefined` for null/undefined/empty input so callers can skip the
 * field entirely rather than emit an empty envelope.
 */
function wrapField(s: string | null | undefined, source: string): string | undefined {
  if (typeof s !== 'string' || s.length === 0) return undefined;
  return wrapUntrusted(s, source);
}

/**
 * Wrap each entry of a vendor-authored string list (tags, domains, …)
 * individually and join the envelopes for display.
 */
function wrapFieldList(list: string[] | null | undefined, source: string): string | undefined {
  if (!list || list.length === 0) return undefined;
  return list.map((item) => wrapUntrusted(item, source)).join(', ');
}

/**
 * Recursively wrap every string VALUE reachable inside `value` in an
 * untrusted-content envelope. Object keys are part of the connector's output
 * contract and stay raw; free-form maps whose KEYS are also authored in
 * Freshdesk (ticket/contact/company `custom_fields`, ticket-field `choices`)
 * are wrapped with `wrapUntrustedJsonStrings` instead, which envelopes keys
 * as well.
 */
function wrapValuesDeep<T>(value: T, source: string): T {
  if (typeof value === 'string') {
    return wrapUntrusted(value, source) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => wrapValuesDeep(item, source)) as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, wrapValuesDeep(item, source)]),
    ) as T;
  }
  return value;
}

/**
 * Wrap a body string in the external-ticket envelope using the canonical
 * shared helper. Returns `undefined` for null/undefined/empty input so
 * callers can skip the field entirely rather than emit an empty envelope.
 *
 * Any `</untrusted-content>` variant (case / whitespace) embedded in `s` is
 * rewritten to a benign textual form before concatenation, so an attacker
 * controlling ticket content cannot break out of the envelope. Idempotent
 * for the same source: `wrap(wrap(s)) === wrap(s)`.
 */
export function wrapUntrustedTicketContent(s: string | null | undefined): string | undefined {
  return wrapField(s, TICKET_SOURCE);
}

/**
 * Render a ticket subject for text output. Fail-closed: a missing, empty,
 * or (in violation of the declared API shape) non-string subject renders a
 * connector-authored placeholder — never the raw vendor value, which an
 * array/object subject would otherwise stringify outside any envelope.
 */
export function formatTicketSubject(subject: string | null | undefined): string {
  return wrapUntrustedTicketContent(subject) ?? '(no subject)';
}

/**
 * Return a deep copy of the ticket with EVERY string value enveloped —
 * subject and body fields, but also type, requester email, tags, and any
 * unexpected vendor property. `custom_fields` is a free-form vendor map whose
 * keys are Freshdesk-authored too, so it is enveloped wholesale (keys
 * included) via `wrapUntrustedJsonStrings`.
 */
export function wrapTicketUntrustedFields(ticket: FreshdeskTicket): FreshdeskTicket {
  const wrapped = wrapValuesDeep(ticket, TICKET_SOURCE);
  if (ticket.custom_fields && typeof ticket.custom_fields === 'object') {
    wrapped.custom_fields = wrapUntrustedJsonStrings(ticket.custom_fields, TICKET_SOURCE);
  }
  return wrapped;
}

export function ticketUrl(domain: string, ticketId: number): string {
  return `https://${domain}.freshdesk.com/a/tickets/${ticketId}`;
}

export function formatTicketConcise(ticket: FreshdeskTicket, domain: string): string {
  const status = statusToString(ticket.status);
  const priority = priorityToString(ticket.priority);
  const subject = formatTicketSubject(ticket.subject);
  return `#${ticket.id}: ${subject} [${status}] (${priority}) — ${ticketUrl(domain, ticket.id)}`;
}

export function formatTicketDetailed(ticket: FreshdeskTicket, domain: string): string {
  const wrappedSubject = formatTicketSubject(ticket.subject);
  const wrappedHtml = wrapUntrustedTicketContent(ticket.description);
  const wrappedText = wrapUntrustedTicketContent(ticket.description_text);
  const wrappedType = wrapUntrustedTicketContent(ticket.type);
  const wrappedEmail = wrapUntrustedTicketContent(ticket.email);
  const wrappedTags = wrapFieldList(ticket.tags, TICKET_SOURCE);
  // Vendor-authored timestamp strings are enveloped too, matching the
  // detailed-JSON mode (wrapValuesDeep catches every string there).
  const wrappedCreated = wrapField(ticket.created_at, TICKET_SOURCE);
  const wrappedUpdated = wrapField(ticket.updated_at, TICKET_SOURCE);
  const wrappedDueBy = wrapField(ticket.due_by, TICKET_SOURCE);
  // The raw numeric id is shown alongside the mapped label, but only when
  // it really is a number — a string-typed status/priority (API shape
  // violation) must never reach the output unenveloped.
  const statusId =
    typeof ticket.status === 'number' && Number.isFinite(ticket.status)
      ? ` (${ticket.status})`
      : '';
  const priorityId =
    typeof ticket.priority === 'number' && Number.isFinite(ticket.priority)
      ? ` (${ticket.priority})`
      : '';
  return [
    `Ticket #${ticket.id}`,
    `URL: ${ticketUrl(domain, ticket.id)}`,
    `Subject: ${wrappedSubject}`,
    `Status: ${statusToString(ticket.status)}${statusId}`,
    `Priority: ${priorityToString(ticket.priority)}${priorityId}`,
    `Source: ${sourceToString(ticket.source)}`,
    wrappedType ? `Type: ${wrappedType}` : '',
    `Requester ID: ${ticket.requester_id}`,
    wrappedEmail ? `Requester Email: ${wrappedEmail}` : '',
    ticket.responder_id ? `Assignee ID: ${ticket.responder_id}` : 'Assignee: unassigned',
    ticket.group_id ? `Group ID: ${ticket.group_id}` : '',
    wrappedCreated ? `Created: ${wrappedCreated}` : '',
    wrappedUpdated ? `Updated: ${wrappedUpdated}` : '',
    wrappedDueBy ? `Due by: ${wrappedDueBy}` : '',
    wrappedTags ? `Tags: ${wrappedTags}` : '',
    wrappedHtml ? `Description (HTML):\n${wrappedHtml}` : '',
    wrappedText ? `Description (text):\n${wrappedText}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatConversation(conv: FreshdeskConversation): string {
  const type = conv.private ? 'Internal note' : conv.incoming ? 'Customer reply' : 'Agent reply';
  const wrappedHtml = wrapUntrustedTicketContent(conv.body);
  const wrappedText = wrapUntrustedTicketContent(conv.body_text);
  const created = wrapField(conv.created_at, TICKET_SOURCE) ?? '(unknown time)';
  const lines: string[] = [`[${created}] ${type} (User ${conv.user_id}):`];
  if (wrappedHtml) lines.push(`Body (HTML): ${wrappedHtml}`);
  if (wrappedText) lines.push(`Body (text): ${wrappedText}`);
  return lines.join('\n');
}

export function formatTicketField(field: FreshdeskTicketField): string {
  const required = field.required_for_agents ? ' [required for agents]' : '';
  const closure = field.required_for_closure ? ' [required for closure]' : '';
  const label = wrapField(field.label, FIELD_SOURCE) ?? '(unlabeled)';
  const name = wrapField(field.name, FIELD_SOURCE) ?? '(unnamed)';
  const type = wrapField(field.type, FIELD_SOURCE) ?? 'unknown';
  return `${label} (ID: ${field.id}, name: ${name}, type: ${type})${required}${closure}`;
}

export function formatAgentConcise(agent: FreshdeskAgent): string {
  const name = wrapField(agent.contact?.name, AGENT_SOURCE) ?? '(no name)';
  const email = wrapField(agent.contact?.email, AGENT_SOURCE) ?? 'no email';
  const availability = agent.available === false ? 'unavailable' : 'available';
  return `#${agent.id}: ${name} <${email}> (${availability})`;
}

export function formatGroupConcise(group: FreshdeskGroup): string {
  const name = wrapField(group.name, GROUP_SOURCE) ?? '(unnamed)';
  const type = wrapField(group.group_type, GROUP_SOURCE);
  return `#${group.id}: ${name}${type ? `, type: ${type}` : ''}`;
}

/**
 * Return a deep copy of the agent with every string value enveloped (contact
 * name/email/phone/mobile, signature, and any unexpected vendor property).
 */
export function wrapAgentUntrustedFields(agent: FreshdeskAgent): FreshdeskAgent {
  return wrapValuesDeep(agent, AGENT_SOURCE);
}

/**
 * Return a deep copy of the group with every string value enveloped (name,
 * description, group type, and any unexpected vendor property).
 */
export function wrapGroupUntrustedFields(group: FreshdeskGroup): FreshdeskGroup {
  return wrapValuesDeep(group, GROUP_SOURCE);
}

export function formatContactConcise(contact: FreshdeskContact): string {
  const name = wrapField(contact.name, CONTACT_SOURCE) ?? '(no name)';
  const email = wrapField(contact.email, CONTACT_SOURCE) ?? 'no email';
  const company = contact.company_id ? ` — company #${contact.company_id}` : '';
  return `#${contact.id}: ${name} <${email}>${company}`;
}

export function formatContactDetailed(contact: FreshdeskContact): string {
  const name = wrapField(contact.name, CONTACT_SOURCE);
  const jobTitle = wrapField(contact.job_title, CONTACT_SOURCE);
  const address = wrapField(contact.address, CONTACT_SOURCE);
  const description = wrapField(contact.description, CONTACT_SOURCE);
  const email = wrapField(contact.email, CONTACT_SOURCE);
  const phone = wrapField(contact.phone, CONTACT_SOURCE);
  const mobile = wrapField(contact.mobile, CONTACT_SOURCE);
  const tags = wrapFieldList(contact.tags, CONTACT_SOURCE);
  const created = wrapField(contact.created_at, CONTACT_SOURCE);
  const updated = wrapField(contact.updated_at, CONTACT_SOURCE);
  return [
    `Contact #${contact.id}`,
    `Name: ${name ?? '(no name)'}`,
    email ? `Email: ${email}` : '',
    phone ? `Phone: ${phone}` : '',
    mobile ? `Mobile: ${mobile}` : '',
    jobTitle ? `Job Title: ${jobTitle}` : '',
    contact.company_id ? `Company ID: ${contact.company_id}` : '',
    address ? `Address: ${address}` : '',
    tags ? `Tags: ${tags}` : '',
    description ? `Description: ${description}` : '',
    created ? `Created: ${created}` : '',
    updated ? `Updated: ${updated}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Return a deep copy of the contact with every string value enveloped (name,
 * email, phone, mobile, tags, … and any unexpected vendor property).
 * `custom_fields` is a free-form vendor map whose keys are Freshdesk-authored
 * too (a tenant-staff-authored field definition controls them), so it is
 * enveloped wholesale (keys included) via `wrapUntrustedJsonStrings`.
 */
export function wrapContactUntrustedFields(contact: FreshdeskContact): FreshdeskContact {
  const wrapped = wrapValuesDeep(contact, CONTACT_SOURCE);
  if (contact.custom_fields && typeof contact.custom_fields === 'object') {
    wrapped.custom_fields = wrapUntrustedJsonStrings(contact.custom_fields, CONTACT_SOURCE);
  }
  return wrapped;
}

export function formatCompanyConcise(company: FreshdeskCompany): string {
  const name = wrapField(company.name, COMPANY_SOURCE) ?? '(unnamed)';
  const domains = wrapFieldList(company.domains, COMPANY_SOURCE);
  return `#${company.id}: ${name}${domains ? ` (${domains})` : ''}`;
}

export function formatCompanyDetailed(company: FreshdeskCompany): string {
  const name = wrapField(company.name, COMPANY_SOURCE);
  const description = wrapField(company.description, COMPANY_SOURCE);
  const note = wrapField(company.note, COMPANY_SOURCE);
  const domains = wrapFieldList(company.domains, COMPANY_SOURCE);
  const industry = wrapField(company.industry, COMPANY_SOURCE);
  const tier = wrapField(company.tier, COMPANY_SOURCE);
  const healthScore = wrapField(company.health_score, COMPANY_SOURCE);
  const created = wrapField(company.created_at, COMPANY_SOURCE);
  const updated = wrapField(company.updated_at, COMPANY_SOURCE);
  return [
    `Company #${company.id}`,
    `Name: ${name ?? '(unnamed)'}`,
    domains ? `Domains: ${domains}` : '',
    industry ? `Industry: ${industry}` : '',
    tier ? `Tier: ${tier}` : '',
    healthScore ? `Health score: ${healthScore}` : '',
    description ? `Description: ${description}` : '',
    note ? `Note: ${note}` : '',
    created ? `Created: ${created}` : '',
    updated ? `Updated: ${updated}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Return a deep copy of the company with every string value enveloped (name,
 * domains, industry, tier, health score, … and any unexpected vendor
 * property). `custom_fields` is a free-form vendor map whose keys are
 * Freshdesk-authored too (a tenant-staff-authored field definition controls
 * them), so it is enveloped wholesale (keys included) via
 * `wrapUntrustedJsonStrings`.
 */
export function wrapCompanyUntrustedFields(company: FreshdeskCompany): FreshdeskCompany {
  const wrapped = wrapValuesDeep(company, COMPANY_SOURCE);
  if (company.custom_fields && typeof company.custom_fields === 'object') {
    wrapped.custom_fields = wrapUntrustedJsonStrings(company.custom_fields, COMPANY_SOURCE);
  }
  return wrapped;
}

export function articleStatusToString(status: number | undefined): string {
  if (status === 1) return 'Draft';
  if (status === 2) return 'Published';
  // Fail-closed: a non-number status (API shape violation) never reaches
  // the output raw.
  return typeof status === 'number' && Number.isFinite(status) ? `Status ${status}` : 'Unknown';
}

export function formatArticleConcise(article: FreshdeskSolutionArticle): string {
  const title = wrapField(article.title, ARTICLE_SOURCE) ?? '(untitled)';
  return `#${article.id}: ${title} [${articleStatusToString(article.status)}]`;
}

export function formatArticleDetailed(article: FreshdeskSolutionArticle): string {
  const title = wrapField(article.title, ARTICLE_SOURCE);
  const wrappedHtml = wrapField(article.description, ARTICLE_SOURCE);
  const wrappedText = wrapField(article.description_text, ARTICLE_SOURCE);
  const tags = wrapFieldList(article.tags, ARTICLE_SOURCE);
  const created = wrapField(article.created_at, ARTICLE_SOURCE);
  const updated = wrapField(article.updated_at, ARTICLE_SOURCE);
  return [
    `Article #${article.id}`,
    `Title: ${title ?? '(untitled)'}`,
    `Status: ${articleStatusToString(article.status)}`,
    article.folder_id ? `Folder ID: ${article.folder_id}` : '',
    article.category_id ? `Category ID: ${article.category_id}` : '',
    tags ? `Tags: ${tags}` : '',
    created ? `Created: ${created}` : '',
    updated ? `Updated: ${updated}` : '',
    wrappedHtml ? `Description (HTML):\n${wrappedHtml}` : '',
    wrappedText ? `Description (text):\n${wrappedText}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Return a deep copy of the article with every string value enveloped (title,
 * HTML and text descriptions, tags, and any unexpected vendor property).
 */
export function wrapArticleUntrustedFields(
  article: FreshdeskSolutionArticle,
): FreshdeskSolutionArticle {
  return wrapValuesDeep(article, ARTICLE_SOURCE);
}

/**
 * Return a deep copy of the ticket field with every string value enveloped
 * (label, name, type, description, …). `choices` is a free-form vendor map
 * whose keys are Freshdesk-authored too, so it is enveloped wholesale (keys
 * included) via `wrapUntrustedJsonStrings`.
 */
export function wrapTicketFieldUntrustedFields(field: FreshdeskTicketField): FreshdeskTicketField {
  const wrapped = wrapValuesDeep(field, FIELD_SOURCE);
  if (field.choices) {
    wrapped.choices = wrapUntrustedJsonStrings(field.choices, FIELD_SOURCE);
  }
  return wrapped;
}
