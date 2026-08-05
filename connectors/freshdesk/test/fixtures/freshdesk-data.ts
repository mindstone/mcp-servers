import type {
  FreshdeskTicket,
  FreshdeskConversation,
  FreshdeskTicketField,
  FreshdeskAgent,
  FreshdeskGroup,
  FreshdeskContact,
  FreshdeskCompany,
  FreshdeskSolutionArticle,
} from '../../src/types.js';

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

export function makeAgent(id: number, overrides: Partial<FreshdeskAgent> = {}): FreshdeskAgent {
  return {
    id,
    available: true,
    occasional: false,
    ticket_scope: 1,
    group_ids: [1],
    contact: {
      name: `Agent ${id}`,
      email: `agent${id}@testacme.freshdesk.com`,
    },
    created_at: '2025-06-01T09:00:00Z',
    updated_at: '2026-01-10T09:00:00Z',
    ...overrides,
  };
}

export function makeGroup(id: number, overrides: Partial<FreshdeskGroup> = {}): FreshdeskGroup {
  return {
    id,
    name: `Group ${id}`,
    description: `Group ${id} description`,
    group_type: 'support',
    created_at: '2025-06-01T09:00:00Z',
    updated_at: '2026-01-10T09:00:00Z',
    ...overrides,
  };
}

export const mockAgents: FreshdeskAgent[] = [
  makeAgent(200),
  makeAgent(201, { contact: { name: 'Jane Agent', email: 'jane@testacme.freshdesk.com' } }),
];

export const mockGroups: FreshdeskGroup[] = [
  makeGroup(1, { name: 'Support' }),
  makeGroup(2, { name: 'Escalations' }),
];

export function makeContact(id: number, overrides: Partial<FreshdeskContact> = {}): FreshdeskContact {
  return {
    id,
    name: `Contact ${id}`,
    email: `contact${id}@example.com`,
    phone: '+14155550100',
    job_title: 'Support Manager',
    company_id: 900,
    description: `Contact ${id} notes`,
    tags: ['vip'],
    active: true,
    created_at: '2025-08-01T09:00:00Z',
    updated_at: '2026-01-10T09:00:00Z',
    ...overrides,
  };
}

export function makeCompany(id: number, overrides: Partial<FreshdeskCompany> = {}): FreshdeskCompany {
  return {
    id,
    name: `Company ${id}`,
    description: `Company ${id} description`,
    note: `Company ${id} internal note`,
    domains: [`company${id}.example.com`],
    industry: 'Software',
    tier: 'Enterprise',
    health_score: 'Good',
    created_at: '2025-08-01T09:00:00Z',
    updated_at: '2026-01-10T09:00:00Z',
    ...overrides,
  };
}

export const mockContacts: FreshdeskContact[] = [
  makeContact(100),
  makeContact(101, { name: 'Jane Customer', email: 'jane@example.com' }),
];

export const mockCompanies: FreshdeskCompany[] = [
  makeCompany(900, { name: 'Acme Corp', domains: ['acme.example.com'] }),
  makeCompany(901, { name: 'TechCorp' }),
];

export function makeArticle(
  id: number,
  overrides: Partial<FreshdeskSolutionArticle> = {},
): FreshdeskSolutionArticle {
  return {
    id,
    title: `Article ${id}: Resetting your password`,
    description: '<p>Go to Settings and click Reset password.</p>',
    description_text: 'Go to Settings and click Reset password.',
    status: 2,
    folder_id: 50,
    category_id: 10,
    thumbs_up: 12,
    thumbs_down: 1,
    hits: 340,
    tags: ['password', 'account'],
    created_at: '2025-09-01T09:00:00Z',
    updated_at: '2026-01-10T09:00:00Z',
    ...overrides,
  };
}

export const mockArticles: FreshdeskSolutionArticle[] = [
  makeArticle(500),
  makeArticle(501, { title: 'Article 501: Billing FAQ', status: 1 }),
];
