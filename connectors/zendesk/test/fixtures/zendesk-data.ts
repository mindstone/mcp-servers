/**
 * Factory functions for Zendesk API response objects.
 * Each returns a realistic object matching the Zendesk REST API schema.
 * All fields have sensible defaults that can be overridden.
 */

import type {
  ZendeskTicket,
  ZendeskUser,
  ZendeskGroup,
  ZendeskTicketField,
  ZendeskComment,
  ZendeskView,
  ZendeskOrganization,
  ZendeskMacro,
  ZendeskHelpCenterArticle,
  ZendeskSatisfactionRating,
} from '../../src/types.js';

export function makeTicket(overrides: Partial<ZendeskTicket> = {}): ZendeskTicket {
  return {
    id: 1,
    subject: 'Test ticket',
    description: 'This is a test ticket description',
    status: 'open',
    priority: 'normal',
    type: 'question',
    requester_id: 100,
    assignee_id: 200,
    group_id: 300,
    created_at: '2026-01-15T10:00:00Z',
    updated_at: '2026-01-15T12:00:00Z',
    tags: ['test'],
    custom_fields: [],
    ...overrides,
  };
}

export function makeUser(overrides: Partial<ZendeskUser> = {}): ZendeskUser {
  return {
    id: 100,
    name: 'Test User',
    email: 'test@example.com',
    role: 'end-user',
    active: true,
    created_at: '2025-06-01T00:00:00Z',
    phone: '+1234567890',
    organization_id: 500,
    ...overrides,
  };
}

export function makeGroup(overrides: Partial<ZendeskGroup> = {}): ZendeskGroup {
  return {
    id: 300,
    name: 'Support',
    description: 'General support group',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-06-01T00:00:00Z',
    ...overrides,
  };
}

export function makeField(overrides: Partial<ZendeskTicketField> = {}): ZendeskTicketField {
  return {
    id: 400,
    type: 'text',
    title: 'Custom Field',
    description: 'A custom text field',
    required: false,
    active: true,
    position: 1,
    custom_field_options: [],
    ...overrides,
  };
}

export function makeComment(overrides: Partial<ZendeskComment> = {}): ZendeskComment {
  return {
    id: 600,
    body: 'This is a test comment',
    author_id: 100,
    created_at: '2026-01-15T11:00:00Z',
    public: true,
    ...overrides,
  };
}

export function makeView(overrides: Partial<ZendeskView> = {}): ZendeskView {
  return {
    id: 700,
    title: 'My Open Tickets',
    active: true,
    position: 1,
    restriction: undefined,
    ...overrides,
  };
}

export function makeOrganization(overrides: Partial<ZendeskOrganization> = {}): ZendeskOrganization {
  return {
    id: 500,
    name: 'Acme Corp',
    domain_names: ['acme.com'],
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-06-01T00:00:00Z',
    details: 'Enterprise customer',
    notes: 'VIP account',
    ...overrides,
  };
}

export function makeMacro(overrides: Partial<ZendeskMacro> = {}): ZendeskMacro {
  return {
    id: 800,
    title: 'Close and Resolve',
    description: 'Sets ticket to solved with a closing comment',
    active: true,
    actions: [
      { field: 'status', value: 'solved' },
      { field: 'comment_value', value: 'This ticket has been resolved.' },
    ],
    restriction: null,
    created_at: '2025-03-01T00:00:00Z',
    updated_at: '2025-06-01T00:00:00Z',
    ...overrides,
  };
}

export function makeArticle(overrides: Partial<ZendeskHelpCenterArticle> = {}): ZendeskHelpCenterArticle {
  return {
    id: 900,
    title: 'How to reset your password',
    body: '<p>Go to Settings &gt; Security and choose Reset password.</p>',
    snippet: 'Go to Settings > Security and choose Reset password.',
    html_url: 'https://testcorp.zendesk.com/hc/en-us/articles/900',
    section_id: 910,
    draft: false,
    vote_sum: 12,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-06-01T00:00:00Z',
    ...overrides,
  };
}

export function makeSatisfactionRating(overrides: Partial<ZendeskSatisfactionRating> = {}): ZendeskSatisfactionRating {
  return {
    id: 950,
    ticket_id: 1,
    assignee_id: 200,
    group_id: 300,
    requester_id: 100,
    score: 'good',
    comment: 'Quick and helpful reply, thanks!',
    created_at: '2026-01-20T09:00:00Z',
    updated_at: '2026-01-20T09:00:00Z',
    ...overrides,
  };
}
