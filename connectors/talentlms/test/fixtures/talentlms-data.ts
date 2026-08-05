/**
 * Test fixtures for TalentLMS MCP connector.
 */

export const MOCK_API_KEY = 'mcp-test-talentlms-key';
export const MOCK_DOMAIN = 'acme';

// ─── Users ──────────────────────────────────────────────

export const mockUsers = [
  { id: '1', login: 'jdoe', first_name: 'Jane', last_name: 'Doe', email: 'jane@acme.com', role: 'learner', status: 'active', last_updated: '2026-02-01', points: '120', level: '2' },
  { id: '2', login: 'bsmith', first_name: 'Bob', last_name: 'Smith', email: 'bob@acme.com', role: 'admin', status: 'active', last_updated: '2026-02-10', points: '450', level: '5' },
  { id: '3', login: 'cjones', first_name: 'Carol', last_name: 'Jones', email: 'carol@acme.com', role: 'learner', status: 'inactive', last_updated: '2026-01-15', points: '30', level: '1' },
];

export const mockUserFull = {
  ...mockUsers[0],
  bio: 'Engineering lead',
  timezone: 'Europe/Athens',
  created_on: '2025-06-01',
  custom_field_1: 'Blue team',
  courses: [
    { id: '10', name: 'Onboarding 101', role: 'learner', completion_status: 'completed', completion_percentage: '100', total_time: '3600', last_accessed: '2026-01-20' },
    { id: '20', name: 'Security Training', role: 'learner', completion_status: 'incomplete', completion_percentage: '45', total_time: '1200', last_accessed: '2026-02-15' },
  ],
  certifications: [
    { course_id: '20', course_name: 'Security Training', unique_id: 'abc123', issued_date: '2026-01-10', expiration_date: '2027-01-10' },
    { course_id: '10', course_name: 'Onboarding 101', unique_id: 'def456', issued_date: '2025-06-15', expiration_date: 'Never' },
  ],
};

export const mockNewUser = {
  id: '4', login: 'newuser', first_name: 'New', last_name: 'User', email: 'new@acme.com', role: 'learner', status: 'active',
};

// ─── Courses ────────────────────────────────────────────

export const mockCourses = [
  { id: '10', name: 'Onboarding 101', code: 'ONB-101', category_id: '1', description: 'New hire onboarding', status: 'active', creation_date: '2025-01-01', price: '0', creator_id: '2' },
  { id: '20', name: 'Security Training', code: 'SEC-200', category_id: '2', description: 'Annual security training', status: 'active', creation_date: '2025-03-15', price: '0', creator_id: '2' },
  { id: '30', name: 'Leadership 301', code: 'LDR-301', category_id: '3', description: 'Leadership skills', status: 'active', creation_date: '2025-06-01', price: '49.99', creator_id: '2' },
];

export const mockCourseFull = {
  ...mockCourses[0],
  users: [
    { id: '1', name: 'Jane Doe', role: 'learner', completion_status: 'completed', completion_percentage: '100', total_time: '3600' },
    { id: '3', name: 'Carol Jones', role: 'learner', completion_status: 'incomplete', completion_percentage: '20', total_time: '600' },
  ],
  units: [
    { id: '100', name: 'Welcome Video', type: 'video' },
    { id: '101', name: 'Company Overview', type: 'document' },
    { id: '102', name: 'Quiz', type: 'test' },
  ],
};

export const mockNewCourse = {
  id: '40', name: 'Created Course', code: 'NEW-100', status: 'active',
};

// ─── Groups ─────────────────────────────────────────────

export const mockGroups = [
  { id: '5', name: 'Sales Team', description: 'All sales reps', creator_id: '2', created_on: '2025-02-01', key: 'sales-2025' },
  { id: '6', name: 'Engineering', description: 'Dev team', creator_id: '2', created_on: '2025-03-01', key: 'eng-2025' },
];

export const mockGroupFull = {
  ...mockGroups[0],
  users: [{ id: '1', name: 'Jane Doe' }, { id: '3', name: 'Carol Jones' }],
  courses: [{ id: '10', name: 'Onboarding 101' }],
};

export const mockNewGroup = {
  id: '7', name: 'New Group', description: 'Test group',
};

// ─── Branches ───────────────────────────────────────────

export const mockBranches = [
  { id: '1', name: 'EMEA', description: 'Europe, Middle East, Africa', created_on: '2025-01-01' },
  { id: '2', name: 'APAC', description: 'Asia Pacific', created_on: '2025-01-01' },
];

// ─── Categories ───────────────────────────────────────────

export const mockCategories = [
  { id: '1', name: 'Onboarding', price: '$0', parent_category_id: '' },
  { id: '2', name: 'Compliance', price: '$0', parent_category_id: '' },
  { id: '3', name: 'Leadership', price: '$49', parent_category_id: '' },
];

// ─── Reporting ──────────────────────────────────────────

export const mockSiteInfo = {
  total_users: '150', total_courses: '25', signup_method: 'email',
  site_name: 'Acme LMS', timezone: 'Europe/Athens', domain: 'acme',
};

export const mockTimeline = [
  { type: 'user_login', user_id: '1', date: '2026-02-19' },
  { type: 'course_completed', user_id: '1', course_id: '10', date: '2026-02-18' },
];

export const mockUserProgress = {
  user_id: '1', course_id: '20', completion_status: 'incomplete',
  units: [
    { id: '200', name: 'Intro', type: 'document', status: 'completed', score: null, time: '300' },
    { id: '201', name: 'Policy Quiz', type: 'test', status: 'incomplete', score: '80', time: '600' },
  ],
};

// ─── Assessments ────────────────────────────────────────

export const mockTestAnswers = {
  test_id: '102', user_id: '1',
  questions: [
    { question: 'What year was the company founded?', user_answer: '2015', correct_answer: '2015', correct: true },
    { question: 'What is our mission?', user_answer: 'Wrong', correct_answer: 'To enable learning', correct: false },
  ],
  score: '50',
};

export const mockSurveyAnswers = {
  survey_id: '200', user_id: '1',
  questions: [
    { question: 'How would you rate this course?', answer: '5/5' },
    { question: 'Any feedback?', answer: 'Great course!' },
  ],
};

export const mockIltSessions = [
  { id: '300', course_id: '30', instructor: 'Bob Smith', date: '2026-03-01', time: '10:00', location: 'Room A', enrolled_users: ['1', '3'] },
];

export const mockSsoLink = { goto_url: 'https://acme.talentlms.com/sso/abc123' };
