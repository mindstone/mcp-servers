/**
 * Response formatting helpers for Freshdesk API data.
 *
 * Text returned by Freshdesk (ticket subjects/descriptions, conversation
 * bodies, contact names, KB article content, …) is third-party text that an
 * end-user or external requester may have written. It is wrapped in
 * `<untrusted-content source="…">…</untrusted-content>` envelopes via the
 * canonical shared helper (vendored at `./untrusted-content.ts`) so the host
 * LLM treats it as data, not instructions. Connector-controlled metadata
 * (ids, statuses, priorities, timestamps, URLs) is NEVER wrapped.
 */

import type {
  FreshdeskTicket,
  FreshdeskConversation,
  FreshdeskTicketField,
  FreshdeskAgent,
  FreshdeskGroup,
  FreshdeskContact,
  FreshdeskCompany,
} from './types.js';
import { statusToString, priorityToString, sourceToString } from './types.js';
import { wrapUntrusted } from './untrusted-content.js';

export const UNTRUSTED_TICKET_OPEN = '<untrusted-content source="external-ticket">';
export const UNTRUSTED_TICKET_CLOSE = '</untrusted-content>';

const TICKET_SOURCE = 'external-ticket';
const AGENT_SOURCE = 'external-agent';
const GROUP_SOURCE = 'external-group';
const CONTACT_SOURCE = 'external-contact';
const COMPANY_SOURCE = 'external-company';

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
 * Return a shallow clone of the ticket with attacker-controlled text fields
 * (subject, HTML and text descriptions) enveloped; connector-controlled
 * metadata is left untouched.
 */
export function wrapTicketUntrustedFields(ticket: FreshdeskTicket): FreshdeskTicket {
  const wrapped: FreshdeskTicket = { ...ticket };
  const ws = wrapUntrustedTicketContent(ticket.subject);
  if (ws !== undefined) wrapped.subject = ws;
  const wd = wrapUntrustedTicketContent(ticket.description);
  if (wd !== undefined) wrapped.description = wd;
  const wdt = wrapUntrustedTicketContent(ticket.description_text);
  if (wdt !== undefined) wrapped.description_text = wdt;
  return wrapped;
}

export function ticketUrl(domain: string, ticketId: number): string {
  return `https://${domain}.freshdesk.com/a/tickets/${ticketId}`;
}

export function formatTicketConcise(ticket: FreshdeskTicket, domain: string): string {
  const status = statusToString(ticket.status);
  const priority = priorityToString(ticket.priority);
  const subject = wrapUntrustedTicketContent(ticket.subject) ?? ticket.subject;
  return `#${ticket.id}: ${subject} [${status}] (${priority}) — ${ticketUrl(domain, ticket.id)}`;
}

export function formatTicketDetailed(ticket: FreshdeskTicket, domain: string): string {
  const wrappedSubject = wrapUntrustedTicketContent(ticket.subject) ?? ticket.subject;
  const wrappedHtml = wrapUntrustedTicketContent(ticket.description);
  const wrappedText = wrapUntrustedTicketContent(ticket.description_text);
  return [
    `Ticket #${ticket.id}`,
    `URL: ${ticketUrl(domain, ticket.id)}`,
    `Subject: ${wrappedSubject}`,
    `Status: ${statusToString(ticket.status)} (${ticket.status})`,
    `Priority: ${priorityToString(ticket.priority)} (${ticket.priority})`,
    `Source: ${sourceToString(ticket.source)}`,
    ticket.type ? `Type: ${ticket.type}` : '',
    `Requester ID: ${ticket.requester_id}`,
    ticket.email ? `Requester Email: ${ticket.email}` : '',
    ticket.responder_id ? `Assignee ID: ${ticket.responder_id}` : 'Assignee: unassigned',
    ticket.group_id ? `Group ID: ${ticket.group_id}` : '',
    `Created: ${ticket.created_at}`,
    `Updated: ${ticket.updated_at}`,
    ticket.due_by ? `Due by: ${ticket.due_by}` : '',
    ticket.tags && ticket.tags.length > 0 ? `Tags: ${ticket.tags.join(', ')}` : '',
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
  const lines: string[] = [`[${conv.created_at}] ${type} (User ${conv.user_id}):`];
  if (wrappedHtml) lines.push(`Body (HTML): ${wrappedHtml}`);
  if (wrappedText) lines.push(`Body (text): ${wrappedText}`);
  return lines.join('\n');
}

export function formatTicketField(field: FreshdeskTicketField): string {
  const required = field.required_for_agents ? ' [required for agents]' : '';
  const closure = field.required_for_closure ? ' [required for closure]' : '';
  return `${field.label} (ID: ${field.id}, name: ${field.name}, type: ${field.type})${required}${closure}`;
}

export function formatAgentConcise(agent: FreshdeskAgent): string {
  const name = wrapField(agent.contact?.name, AGENT_SOURCE) ?? '(no name)';
  const email = agent.contact?.email ?? 'no email';
  const availability = agent.available === false ? 'unavailable' : 'available';
  return `#${agent.id}: ${name} <${email}> (${availability})`;
}

export function formatGroupConcise(group: FreshdeskGroup): string {
  const name = wrapField(group.name, GROUP_SOURCE) ?? '(unnamed)';
  const type = group.group_type ? `, type: ${group.group_type}` : '';
  return `#${group.id}: ${name}${type}`;
}

/**
 * Return a shallow clone of the agent with external-text fields (display
 * name, signature) enveloped; ids and timestamps are left untouched.
 */
export function wrapAgentUntrustedFields(agent: FreshdeskAgent): FreshdeskAgent {
  const wrapped: FreshdeskAgent = { ...agent };
  if (agent.contact) {
    const name = wrapField(agent.contact.name, AGENT_SOURCE);
    wrapped.contact = { ...agent.contact, ...(name !== undefined ? { name } : {}) };
  }
  const signature = wrapField(agent.signature, AGENT_SOURCE);
  if (signature !== undefined) wrapped.signature = signature;
  return wrapped;
}

/**
 * Return a shallow clone of the group with external-text fields (name,
 * description) enveloped; ids and timestamps are left untouched.
 */
export function wrapGroupUntrustedFields(group: FreshdeskGroup): FreshdeskGroup {
  const wrapped: FreshdeskGroup = { ...group };
  const name = wrapField(group.name, GROUP_SOURCE);
  if (name !== undefined) wrapped.name = name;
  const description = wrapField(group.description, GROUP_SOURCE);
  if (description !== undefined) wrapped.description = description;
  return wrapped;
}

export function formatContactConcise(contact: FreshdeskContact): string {
  const name = wrapField(contact.name, CONTACT_SOURCE) ?? '(no name)';
  const email = contact.email ?? 'no email';
  const company = contact.company_id ? ` — company #${contact.company_id}` : '';
  return `#${contact.id}: ${name} <${email}>${company}`;
}

export function formatContactDetailed(contact: FreshdeskContact): string {
  const name = wrapField(contact.name, CONTACT_SOURCE);
  const jobTitle = wrapField(contact.job_title, CONTACT_SOURCE);
  const address = wrapField(contact.address, CONTACT_SOURCE);
  const description = wrapField(contact.description, CONTACT_SOURCE);
  return [
    `Contact #${contact.id}`,
    `Name: ${name ?? '(no name)'}`,
    contact.email ? `Email: ${contact.email}` : '',
    contact.phone ? `Phone: ${contact.phone}` : '',
    contact.mobile ? `Mobile: ${contact.mobile}` : '',
    jobTitle ? `Job Title: ${jobTitle}` : '',
    contact.company_id ? `Company ID: ${contact.company_id}` : '',
    address ? `Address: ${address}` : '',
    contact.tags && contact.tags.length > 0 ? `Tags: ${contact.tags.join(', ')}` : '',
    description ? `Description: ${description}` : '',
    contact.created_at ? `Created: ${contact.created_at}` : '',
    contact.updated_at ? `Updated: ${contact.updated_at}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Return a shallow clone of the contact with external-text fields enveloped;
 * ids, emails, and timestamps are left untouched.
 */
export function wrapContactUntrustedFields(contact: FreshdeskContact): FreshdeskContact {
  const wrapped: FreshdeskContact = { ...contact };
  for (const key of ['name', 'job_title', 'address', 'description'] as const) {
    const value = wrapField(contact[key], CONTACT_SOURCE);
    if (value !== undefined) wrapped[key] = value;
  }
  return wrapped;
}

export function formatCompanyConcise(company: FreshdeskCompany): string {
  const name = wrapField(company.name, COMPANY_SOURCE) ?? '(unnamed)';
  const domains = company.domains && company.domains.length > 0 ? ` (${company.domains.join(', ')})` : '';
  return `#${company.id}: ${name}${domains}`;
}

export function formatCompanyDetailed(company: FreshdeskCompany): string {
  const name = wrapField(company.name, COMPANY_SOURCE);
  const description = wrapField(company.description, COMPANY_SOURCE);
  const note = wrapField(company.note, COMPANY_SOURCE);
  return [
    `Company #${company.id}`,
    `Name: ${name ?? '(unnamed)'}`,
    company.domains && company.domains.length > 0 ? `Domains: ${company.domains.join(', ')}` : '',
    company.industry ? `Industry: ${company.industry}` : '',
    company.tier ? `Tier: ${company.tier}` : '',
    company.health_score ? `Health score: ${company.health_score}` : '',
    description ? `Description: ${description}` : '',
    note ? `Note: ${note}` : '',
    company.created_at ? `Created: ${company.created_at}` : '',
    company.updated_at ? `Updated: ${company.updated_at}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Return a shallow clone of the company with external-text fields enveloped;
 * ids, domains, and timestamps are left untouched.
 */
export function wrapCompanyUntrustedFields(company: FreshdeskCompany): FreshdeskCompany {
  const wrapped: FreshdeskCompany = { ...company };
  for (const key of ['name', 'description', 'note'] as const) {
    const value = wrapField(company[key], COMPANY_SOURCE);
    if (value !== undefined) wrapped[key] = value;
  }
  return wrapped;
}
