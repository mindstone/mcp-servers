import type {
  FormatOptions,
  ZendeskTicket,
  ZendeskUser,
  ZendeskGroup,
  ZendeskTicketField,
  ZendeskMacro,
} from './types.js';

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
