/**
 * Humaans test data fixtures.
 */

export const mockMe = {
  id: 'person-me-001',
  firstName: 'Alice',
  lastName: 'Smith',
  preferredName: null,
  email: 'alice@example.com',
  status: 'active',
  contractType: 'fullTime',
  teams: [{ name: 'Engineering' }],
  locationId: 'loc-001',
  employmentStartDate: '2023-01-15',
  employmentEndDate: null,
  timezone: 'Europe/London',
  jobRole: { jobTitle: 'Senior Engineer', department: 'Engineering' },
  // Sensitive fields that should be stripped
  taxId: 'SENSITIVE-TAX-ID',
  personalEmail: 'alice.personal@gmail.com',
  birthday: '1990-03-15',
  address: '123 Secret St',
};

export const mockPeople = [
  {
    id: 'person-001',
    firstName: 'Alice',
    lastName: 'Smith',
    preferredName: null,
    email: 'alice@example.com',
    status: 'active',
    contractType: 'fullTime',
    teams: [{ name: 'Engineering' }],
    locationId: 'loc-001',
    employmentStartDate: '2023-01-15',
    employmentEndDate: null,
    timezone: 'Europe/London',
    jobRole: { jobTitle: 'Senior Engineer', department: 'Engineering' },
  },
  {
    id: 'person-002',
    firstName: 'Bob',
    lastName: 'Jones',
    preferredName: 'Bobby',
    email: 'bob@example.com',
    status: 'active',
    contractType: 'partTime',
    teams: [{ name: 'Sales' }],
    locationId: 'loc-002',
    employmentStartDate: '2023-06-01',
    employmentEndDate: null,
    timezone: 'America/New_York',
    jobRole: { jobTitle: 'Sales Rep', department: 'Sales' },
  },
];

export const mockJobRoles = [
  {
    id: 'role-001',
    personId: 'person-001',
    jobTitle: 'Senior Engineer',
    department: 'Engineering',
    reportingTo: 'person-003',
    effectiveDate: '2024-01-01',
    endDate: null,
    note: 'Promoted from mid-level',
  },
  {
    id: 'role-002',
    personId: 'person-001',
    jobTitle: 'Engineer',
    department: 'Engineering',
    reportingTo: 'person-003',
    effectiveDate: '2023-01-15',
    endDate: '2023-12-31',
    note: null,
  },
];

export const mockLocations = [
  {
    id: 'loc-001',
    label: 'London HQ',
    city: 'London',
    country: 'United Kingdom',
    timezone: 'Europe/London',
  },
  {
    id: 'loc-002',
    label: 'New York Office',
    city: 'New York',
    country: 'United States',
    timezone: 'America/New_York',
  },
];

export const mockCompany = {
  id: 'company-001',
  name: 'Acme Corp',
  status: 'active',
  trialEndDate: null,
  timesheetEnabled: true,
};

export const mockTimeAway = [
  {
    id: 'ta-001',
    personId: 'person-001',
    startDate: '2024-03-15',
    endDate: '2024-03-15',
    timeAwayTypeId: 'tat-001',
    timeAwayType: { id: 'tat-001', name: 'Paid time off' },
    requestStatus: 'approved',
    startPeriod: 'full',
    endPeriod: 'full',
    days: 1,
    note: 'Doctor appointment',
  },
  {
    id: 'ta-002',
    personId: 'person-002',
    startDate: '2024-04-01',
    endDate: '2024-04-05',
    timeAwayTypeId: 'tat-001',
    timeAwayType: { id: 'tat-001', name: 'Paid time off' },
    requestStatus: 'pending',
    startPeriod: 'full',
    endPeriod: 'full',
    days: 5,
    note: 'Vacation',
  },
];

export const mockTimeAwayTypes = [
  { id: 'tat-001', name: 'Paid time off', color: '#4CAF50' },
  { id: 'tat-002', name: 'Sick leave', color: '#FF9800' },
  { id: 'tat-003', name: 'Working from home', color: '#2196F3' },
];

export const mockCreatedTimeAway = {
  id: 'ta-new-001',
  personId: 'person-001',
  startDate: '2024-05-01',
  endDate: '2024-05-02',
  timeAwayTypeId: 'tat-001',
  timeAwayType: { id: 'tat-001', name: 'Paid time off' },
  requestStatus: 'pending',
  startPeriod: 'full',
  endPeriod: 'full',
  days: 2,
  note: 'Short break',
};
