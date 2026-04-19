/**
 * Mixmax test data fixtures.
 */

export const mockSequences = [
  {
    _id: 'seq-001',
    name: 'Onboarding Drip',
    numStages: 5,
    isPaused: false,
    numRecipients: 150,
    numFinished: 120,
    numBounced: 3,
    createdAt: '2026-01-10T10:00:00.000Z',
  },
  {
    _id: 'seq-002',
    name: 'Follow-up Sequence',
    numStages: 3,
    isPaused: true,
    numRecipients: 50,
    numFinished: 40,
    numBounced: 1,
    createdAt: '2026-01-15T14:00:00.000Z',
  },
];

export const mockSequenceDetail = {
  _id: 'seq-001',
  name: 'Onboarding Drip',
  isPaused: false,
  createdAt: '2026-01-10T10:00:00.000Z',
  numRecipients: 150,
  numFinished: 120,
  numBounced: 3,
  stages: [
    {
      subject: 'Welcome to Acme!',
      body: '<p>Hi {{first_name}},</p><p>Welcome aboard!</p>',
      delay: { value: 0, unit: 'days' },
    },
    {
      subject: 'Getting started guide',
      body: '<p>Here are some resources to get you started.</p>',
      delay: { value: 2, unit: 'days' },
    },
  ],
};

export const mockMessages = [
  {
    _id: 'msg-001',
    subject: 'Quarterly Update',
    recipients: {
      to: [{ email: 'alice@acme.com' }],
      cc: [{ email: 'manager@acme.com' }],
    },
    sentAt: '2026-01-20T09:00:00.000Z',
    opens: 3,
    clicks: 1,
    state: 'sent',
  },
  {
    _id: 'msg-002',
    subject: 'Meeting Follow-up',
    recipients: {
      to: [{ email: 'bob@acme.com' }],
    },
    sentAt: '2026-01-21T11:00:00.000Z',
    opens: 0,
    clicks: 0,
    state: 'sent',
  },
];

export const mockSnippets = [
  {
    _id: 'snip-001',
    name: 'Cold Outreach Template',
    subject: 'Quick question for {{company}}',
    body: '<p>Hi {{first_name}},</p><p>I noticed your company {{company}} is growing fast.</p>',
    isShared: true,
  },
  {
    _id: 'snip-002',
    name: 'Follow-up Template',
    subject: 'Following up',
    body: '<p>Hi {{first_name}},</p><p>Just wanted to follow up on my previous email.</p>',
    isShared: false,
  },
];

export const mockMeetingTypes = [
  {
    name: '30 min intro call',
    duration: 30,
    location: 'Zoom',
    slug: 'intro-30',
    link: 'https://app.mixmax.com/m/intro-30',
  },
  {
    name: '60 min deep dive',
    duration: 60,
    location: 'Google Meet',
    slug: 'deep-dive-60',
    link: 'https://app.mixmax.com/m/deep-dive-60',
  },
];

export const mockUser = {
  _id: 'user-001',
  name: 'Test User',
  email: 'testuser@acme.com',
  plan: 'Growth',
  integrations: ['Gmail', 'Salesforce'],
};

export const mockSendResult = {
  _id: 'msg-new-001',
  status: 'sent',
};

export const mockAddRecipientsResult = {
  added: 2,
  errors: [],
};

export const mockSnippetSendResult = {
  _id: 'msg-snip-001',
  status: 'sent',
};
