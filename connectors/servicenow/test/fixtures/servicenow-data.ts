export const mockIncidents = [
  {
    number: 'INC0010001',
    sys_id: 'inc-sys-id-001',
    short_description: 'VPN not connecting',
    state: 'New',
    priority: '3 - Moderate',
    assigned_to: 'John Smith',
    sys_created_on: '2026-03-01T10:00:00Z',
    sys_updated_on: '2026-03-01T10:05:00Z',
    urgency: '2 - Medium',
    impact: '2 - Medium',
  },
  {
    number: 'INC0010002',
    sys_id: 'inc-sys-id-002',
    short_description: 'Email server down',
    state: 'In Progress',
    priority: '1 - Critical',
    assigned_to: 'Jane Doe',
    sys_created_on: '2026-03-02T08:00:00Z',
    sys_updated_on: '2026-03-02T09:00:00Z',
    urgency: '1 - High',
    impact: '1 - High',
  },
];

export const mockIncidentDetail = {
  number: 'INC0010001',
  sys_id: 'inc-sys-id-001',
  short_description: 'VPN not connecting',
  description: 'Users unable to connect to corporate VPN since this morning.',
  state: 'New',
  priority: '3 - Moderate',
  assigned_to: 'John Smith',
  assignment_group: 'Network Team',
  caller_id: 'alice.bob',
  category: 'Network',
  sys_created_on: '2026-03-01T10:00:00Z',
  sys_updated_on: '2026-03-01T10:05:00Z',
  urgency: '2 - Medium',
  impact: '2 - Medium',
  opened_by: 'admin',
  resolved_by: '',
  close_code: '',
  close_notes: '',
};

export const mockChangeRequests = [
  {
    number: 'CHG0010001',
    sys_id: 'chg-sys-id-001',
    short_description: 'Upgrade database server',
    state: 'New',
    type: 'normal',
    priority: '3 - Moderate',
    assigned_to: 'Bob Admin',
    start_date: '2026-04-01T08:00:00Z',
    end_date: '2026-04-01T12:00:00Z',
  },
  {
    number: 'CHG0010002',
    sys_id: 'chg-sys-id-002',
    short_description: 'Deploy security patch',
    state: 'Implement',
    type: 'emergency',
    priority: '1 - Critical',
    assigned_to: 'Jane Doe',
    start_date: '2026-03-15T06:00:00Z',
    end_date: '2026-03-15T08:00:00Z',
  },
];

export const mockChangeRequestDetail = {
  ...mockChangeRequests[0],
  description: 'Upgrade PostgreSQL from 14 to 16 on production database server.',
  risk: '3 - Moderate',
  category: 'Hardware',
  close_code: '',
  close_notes: '',
};

export const mockKnowledgeArticles = [
  {
    number: 'KB0010001',
    sys_id: 'kb-sys-id-001',
    short_description: 'How to set up VPN on macOS',
    sys_created_on: '2026-01-15T10:00:00Z',
    author: 'admin',
    kb_knowledge_base: 'IT Knowledge Base',
    workflow_state: 'published',
  },
  {
    number: 'KB0010002',
    sys_id: 'kb-sys-id-002',
    short_description: 'Password reset instructions',
    sys_created_on: '2026-02-01T08:00:00Z',
    author: 'admin',
    kb_knowledge_base: 'IT Knowledge Base',
    workflow_state: 'published',
  },
];

export const mockKnowledgeArticleDetail = {
  ...mockKnowledgeArticles[0],
  text: '<h1>VPN Setup Guide</h1><p>Follow these steps to set up VPN on macOS...</p>',
  article_type: 'text',
  description: 'Step-by-step guide for configuring VPN access on macOS.',
};

export const mockUsers = [
  {
    sys_id: 'user-sys-id-001',
    user_name: 'john.smith',
    first_name: 'John',
    last_name: 'Smith',
    email: 'john.smith@example.com',
    title: 'Network Engineer',
    department: 'IT',
    active: 'true',
  },
  {
    sys_id: 'user-sys-id-002',
    user_name: 'jane.doe',
    first_name: 'Jane',
    last_name: 'Doe',
    email: 'jane.doe@example.com',
    title: 'Senior Developer',
    department: 'Engineering',
    active: 'true',
  },
];
