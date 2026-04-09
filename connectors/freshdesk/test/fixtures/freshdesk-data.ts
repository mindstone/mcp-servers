import type { FreshdeskTicket, FreshdeskConversation, FreshdeskTicketField } from '../../src/types.js';

export function makeTicket(id: number, overrides: Partial<FreshdeskTicket> = {}): FreshdeskTicket {
  return {
    id,
    subject: `Ticket ${id}: Login issue`,
    description: '<p>Cannot log in to the portal</p>',
    description_text: 'Cannot log in to the portal',
    status: 2,
    priority: 3,
    source: 1,
    requester_id: 100,
    responder_id: 200,
    email: 'customer@test.com',
    created_at: '2026-01-15T10:00:00Z',
    updated_at: '2026-01-15T12:00:00Z',
    tags: ['login', 'urgent'],
    ...overrides,
  };
}

export function makeConversation(
  id: number,
  overrides: Partial<FreshdeskConversation> = {},
): FreshdeskConversation {
  return {
    id,
    body: '<p>We are looking into this.</p>',
    body_text: 'We are looking into this.',
    incoming: false,
    private: false,
    user_id: 200,
    from_email: 'support@testacme.freshdesk.com',
    created_at: '2026-01-15T11:00:00Z',
    updated_at: '2026-01-15T11:00:00Z',
    source: 0,
    ...overrides,
  };
}

export function makeTicketField(
  id: number,
  name: string,
  label: string,
  type: string,
): FreshdeskTicketField {
  return {
    id,
    name,
    label,
    description: `${label} field`,
    type,
    required_for_closure: false,
    required_for_agents: false,
    default: true,
    position: id,
  };
}

export const mockTickets: FreshdeskTicket[] = [
  makeTicket(1),
  makeTicket(2, { subject: 'Ticket 2: Password reset', status: 3, priority: 2 }),
  makeTicket(3, { subject: 'Ticket 3: Feature request', status: 4, priority: 1 }),
];

export const mockConversations: FreshdeskConversation[] = [
  makeConversation(10),
  makeConversation(11, {
    incoming: true,
    body_text: 'Customer follow-up',
    user_id: 100,
  }),
];

export const mockTicketFields: FreshdeskTicketField[] = [
  makeTicketField(1, 'status', 'Status', 'default_status'),
  makeTicketField(2, 'priority', 'Priority', 'default_priority'),
  makeTicketField(3, 'subject', 'Subject', 'default_subject'),
  makeTicketField(4, 'cf_custom_dropdown', 'Custom Dropdown', 'custom_dropdown'),
];
