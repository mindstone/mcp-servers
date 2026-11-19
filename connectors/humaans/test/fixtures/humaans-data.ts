/**
 * Humaans test data fixtures.
 */

export const mockMe = {
  id: 'personme',
  firstName: 'Alice',
  lastName: 'Smith',
  preferredName: null,
  email: 'alice@example.com',
  status: 'active',
  contractType: 'fullTime',
  teams: [{ name: 'Engineering' }],
  locationId: 'loc001',
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
    id: 'person001',
    firstName: 'Alice',
    lastName: 'Smith',
    preferredName: null,
    email: 'alice@example.com',
    status: 'active',
    contractType: 'fullTime',
    teams: [{ name: 'Engineering' }],
    locationId: 'loc001',
    employmentStartDate: '2023-01-15',
    employmentEndDate: null,
    timezone: 'Europe/London',
    jobRole: { jobTitle: 'Senior Engineer', department: 'Engineering' },
  },
  {
    id: 'person002',
    firstName: 'Bob',
    lastName: 'Jones',
    preferredName: 'Bobby',
    email: 'bob@example.com',
    status: 'active',
    contractType: 'partTime',
    teams: [{ name: 'Sales' }],
    locationId: 'loc002',
    employmentStartDate: '2023-06-01',
    employmentEndDate: null,
    timezone: 'America/New_York',
    jobRole: { jobTitle: 'Sales Rep', department: 'Sales' },
  },
];

export const mockJobRoles = [
  {
    id: 'role001',
    personId: 'person001',
    jobTitle: 'Senior Engineer',
    department: 'Engineering',
    reportingTo: 'person003',
    effectiveDate: '2024-01-01',
    endDate: null,
    note: 'Promoted from mid-level',
  },
  {
    id: 'role002',
    personId: 'person001',
    jobTitle: 'Engineer',
    department: 'Engineering',
    reportingTo: 'person003',
    effectiveDate: '2023-01-15',
    endDate: '2023-12-31',
    note: null,
  },
];

export const mockLocations = [
  {
    id: 'loc001',
    label: 'London HQ',
    city: 'London',
    country: 'United Kingdom',
    timezone: 'Europe/London',
  },
  {
    id: 'loc002',
    label: 'New York Office',
    city: 'New York',
    country: 'United States',
    timezone: 'America/New_York',
  },
];

export const mockCompany = {
  id: 'company001',
  name: 'Acme Corp',
  status: 'active',
  trialEndDate: null,
  timesheetEnabled: true,
};

export const mockTimeAway = [
  {
    id: 'ta001',
    personId: 'person001',
    startDate: '2024-03-15',
    endDate: '2024-03-15',
    timeAwayTypeId: 'tat001',
    timeAwayType: { id: 'tat001', name: 'Paid time off' },
    requestStatus: 'approved',
    startPeriod: 'full',
    endPeriod: 'full',
    days: 1,
    note: 'Doctor appointment',
  },
  {
    id: 'ta002',
    personId: 'person002',
    startDate: '2024-04-01',
    endDate: '2024-04-05',
    timeAwayTypeId: 'tat001',
    timeAwayType: { id: 'tat001', name: 'Paid time off' },
    requestStatus: 'pending',
    startPeriod: 'full',
    endPeriod: 'full',
    days: 5,
    note: 'Vacation',
  },
];

export const mockTimeAwayTypes = [
  { id: 'tat001', name: 'Paid time off', color: '#4CAF50' },
  { id: 'tat002', name: 'Sick leave', color: '#FF9800' },
  { id: 'tat003', name: 'Working from home', color: '#2196F3' },
];

export const mockCreatedTimeAway = {
  id: 'tanew',
  personId: 'person001',
  startDate: '2024-05-01',
  endDate: '2024-05-02',
  timeAwayTypeId: 'tat001',
  timeAwayType: { id: 'tat001', name: 'Paid time off' },
  requestStatus: 'pending',
  startPeriod: 'full',
  endPeriod: 'full',
  days: 2,
  note: 'Short break',
};

export const mockTimeAwayAllocations = [
  {
    id: 'alloc001',
    personId: 'person001',
    type: 'specific',
    effectiveDate: '2024-01-01',
    timeAwayPolicyId: 'policy001',
    timeAwayPolicy: { id: 'policy001', name: 'Standard PTO' },
    createdAt: '2024-01-01T09:00:00.000Z',
    updatedAt: '2024-01-01T09:00:00.000Z',
  },
  {
    id: 'alloc002',
    personId: 'person002',
    type: 'placeOfWork',
    effectiveDate: null,
    timeAwayPolicyId: 'policy002',
    timeAwayPolicy: { id: 'policy002', name: 'US PTO' },
    createdAt: '2024-01-02T09:00:00.000Z',
    updatedAt: '2024-01-02T09:00:00.000Z',
  },
];
