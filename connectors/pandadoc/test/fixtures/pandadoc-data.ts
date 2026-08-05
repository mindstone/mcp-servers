export const mockDocuments = [
  {
    id: 'doc-1',
    name: 'Sales Contract',
    status: 'document.draft',
    date_created: '2026-03-01T10:00:00Z',
    date_modified: '2026-03-01T10:05:00Z',
    expiration_date: null,
    version: '2',
  },
  {
    id: 'doc-2',
    name: 'NDA Agreement',
    status: 'document.sent',
    date_created: '2026-02-15T08:00:00Z',
    date_modified: '2026-02-20T14:30:00Z',
    expiration_date: '2026-04-15T00:00:00Z',
    version: '1',
  },
];

export const mockDocumentDetails = {
  id: 'doc-1',
  name: 'Sales Contract',
  status: 'document.draft',
  date_created: '2026-03-01T10:00:00Z',
  date_modified: '2026-03-01T10:05:00Z',
  date_completed: null,
  date_sent: null,
  expiration_date: null,
  version: '2',
  created_by: { id: 'user-1', email: 'admin@co.com', first_name: 'Admin', last_name: 'User' },
  template: { id: 'tmpl-1', name: 'Sales Template' },
  recipients: [
    {
      id: 'rcpt-1',
      first_name: 'Jane',
      last_name: 'Doe',
      email: 'jane@client.com',
      recipient_type: 'signer',
      role: 'Client',
    },
  ],
  fields: [{ uuid: 'f-1', name: 'Signature', type: 'signature' }],
  tokens: [],
  metadata: {},
  tags: ['sales'],
  grand_total: { amount: '5000', currency: 'USD' },
  linked_objects: [],
};

export const mockTemplates = [
  {
    id: 'tmpl-1',
    name: 'Sales Template',
    date_created: '2026-01-01T00:00:00Z',
    date_modified: '2026-02-01T00:00:00Z',
    version: '2',
  },
  {
    id: 'tmpl-2',
    name: 'NDA Template',
    date_created: '2025-06-01T00:00:00Z',
    date_modified: '2025-12-01T00:00:00Z',
    version: '3',
  },
];

export const mockCreateFromTemplateResponse = {
  id: 'doc-tmpl-1',
  name: 'Q1 Proposal',
  status: 'document.uploaded',
  date_created: '2026-03-10T12:00:00Z',
  date_modified: '2026-03-10T12:00:00Z',
  expiration_date: null,
  version: null,
  uuid: 'doc-tmpl-1',
  links: [
    {
      rel: 'status',
      href: 'https://api.pandadoc.com/public/v1/documents/doc-tmpl-1',
      type: 'GET',
    },
  ],
  info_message:
    'You need to poll the Document Status method until the status will be changed to document.draft',
};

export const mockSendResponse = {
  id: 'doc-1',
  name: 'Sales Contract',
  status: 'document.sent',
  date_created: '2026-03-01T10:00:00Z',
  date_modified: '2026-03-10T12:05:00Z',
  recipients: [
    {
      id: 'rcpt-1',
      first_name: 'Jane',
      last_name: 'Doe',
      email: 'jane@client.com',
      shared_link: 'https://app.pandadoc.com/document/abc123',
    },
  ],
};

export const mockSessionResponse = {
  id: 'nPh2PDhFdDqAES9k64h9qX',
  expires_at: '2026-03-10T13:05:00.000000Z',
};

export const mockDocumentFolders = [
  {
    uuid: 'folder-1',
    name: 'Client Contracts',
    date_created: '2026-01-15T09:00:00.000000Z',
    has_folders: false,
    has_items: true,
  },
  {
    uuid: 'folder-2',
    name: 'HR Documents',
    date_created: '2026-02-01T09:00:00.000000Z',
    has_folders: true,
    has_items: true,
  },
];

export const mockContacts = [
  {
    id: 'contact-1',
    email: 'jane@client.com',
    first_name: 'Jane',
    last_name: 'Doe',
    company: 'Acme Corp',
    job_title: 'Procurement Manager',
    phone: '+1-555-123-4567',
    country: 'USA',
    state: 'California',
    street_address: '1234 Elm Street',
    city: 'San Francisco',
    postal_code: '94101',
  },
  {
    id: 'contact-2',
    email: 'john@example.com',
    first_name: 'John',
    last_name: 'Smith',
    company: 'TechCorp',
    job_title: 'CTO',
    phone: null,
    country: null,
    state: null,
    street_address: null,
    city: null,
    postal_code: null,
  },
];

export const mockContentLibraryItems = [
  {
    id: 'cli-1',
    name: 'Standard Pricing Table',
    date_created: '2026-01-10T08:00:00.000000Z',
    date_modified: '2026-02-10T08:00:00.000000Z',
    version: '2',
  },
  {
    id: 'cli-2',
    name: 'Mutual NDA Clause',
    date_created: '2026-01-20T08:00:00.000000Z',
    date_modified: '2026-01-20T08:00:00.000000Z',
    version: '1',
  },
];

export const mockContentLibraryItemDetails = {
  id: 'cli-1',
  name: 'Standard Pricing Table',
  date_created: '2026-01-10T08:00:00.000000Z',
  date_modified: '2026-02-10T08:00:00.000000Z',
  content_date_modified: '2026-02-10T08:00:00.000000Z',
  created_by: { id: 'user-1', email: 'admin@co.com', first_name: 'Admin', last_name: 'User' },
  metadata: { department: 'sales' },
  tokens: [{ name: 'Client.CompanyName', value: '' }],
  fields: [],
  pricing: { tables: [] },
  tags: ['approved'],
  roles: [],
  version: '2',
};
