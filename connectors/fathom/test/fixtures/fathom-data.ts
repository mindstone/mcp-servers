/**
 * Fathom test data fixtures.
 */

export const mockMeetings = [
  {
    title: 'Weekly Standup',
    meeting_title: 'Weekly Standup',
    recording_id: 101,
    url: 'https://fathom.video/recordings/101',
    share_url: 'https://fathom.video/share/101',
    created_at: '2026-01-15T10:00:00.000Z',
    scheduled_start_time: '2026-01-15T10:00:00.000Z',
    scheduled_end_time: '2026-01-15T10:30:00.000Z',
    recording_start_time: '2026-01-15T10:00:00.000Z',
    recording_end_time: '2026-01-15T10:28:00.000Z',
    calendar_invitees_domains_type: 'only_internal',
    transcript_language: 'en',
    calendar_invitees: [
      { name: 'Alice', email: 'alice@example.com', email_domain: 'example.com', is_external: false },
      { name: 'Bob', email: 'bob@example.com', email_domain: 'example.com', is_external: false },
    ],
    recorded_by: { name: 'Alice', email: 'alice@example.com', email_domain: 'example.com', team: null },
    action_items: [
      {
        description: 'Send the updated proposal to the client',
        user_generated: false,
        completed: false,
        recording_timestamp: '00:10:45',
        recording_playback_url: 'https://fathom.video/recordings/101#t=645',
        assignee: { name: 'Alice', email: 'alice@example.com', team: null },
      },
      {
        description: 'Book the sprint retrospective',
        user_generated: true,
        completed: true,
        recording_timestamp: '00:18:02',
        recording_playback_url: 'https://fathom.video/recordings/101#t=1082',
        assignee: { name: 'Bob', email: 'bob@example.com', team: null },
      },
    ],
  },
  {
    title: 'Sprint Review',
    meeting_title: 'Sprint Review',
    recording_id: 102,
    url: 'https://fathom.video/recordings/102',
    share_url: 'https://fathom.video/share/102',
    created_at: '2026-01-16T14:00:00.000Z',
    scheduled_start_time: '2026-01-16T14:00:00.000Z',
    scheduled_end_time: '2026-01-16T15:00:00.000Z',
    recording_start_time: '2026-01-16T14:00:00.000Z',
    recording_end_time: '2026-01-16T14:55:00.000Z',
    calendar_invitees_domains_type: 'only_internal',
    transcript_language: 'en',
    calendar_invitees: [
      { name: 'Carol', email: 'carol@example.com', email_domain: 'example.com', is_external: false },
    ],
    recorded_by: { name: 'Carol', email: 'carol@example.com', email_domain: 'example.com', team: null },
  },
];

export const mockTranscript = {
  transcript: [
    {
      speaker: { name: 'Alice', display_name: 'Alice', email: 'alice@example.com' },
      start_time: 0,
      end_time: 5,
      text: 'Good morning everyone.',
    },
    {
      speaker: { name: 'Bob', display_name: 'Bob', email: 'bob@example.com' },
      start_time: 5,
      end_time: 12,
      text: 'Morning! Let me share my update.',
    },
    {
      speaker: { name: 'Alice', display_name: 'Alice', email: 'alice@example.com' },
      start_time: 12,
      end_time: 20,
      text: 'Sounds good. Go ahead.',
    },
  ],
};

export const mockSummary = {
  summary: {
    template_name: 'Default',
    markdown_formatted: '## Summary\nTeam discussed project updates.',
  },
};

export const mockTeams = [
  { name: 'Engineering', created_at: '2025-01-01T00:00:00Z' },
  { name: 'Sales', created_at: '2025-02-01T00:00:00Z' },
];

export const mockTeamMembers = [
  { id: 'user-1', email: 'alice@example.com', name: 'Alice', role: 'admin', joined_at: '2025-01-01T00:00:00Z' },
  { id: 'user-2', email: 'bob@example.com', name: 'Bob', role: 'member', joined_at: '2025-01-15T00:00:00Z' },
];
