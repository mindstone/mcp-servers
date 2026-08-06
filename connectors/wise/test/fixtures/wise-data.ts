/**
 * Mock Wise API data. All names/companies are fictional placeholders.
 */

export const mockProfiles = [
  {
    id: 12345,
    type: 'PERSONAL',
    fullName: 'Jane Doe',
    firstName: 'Jane',
    lastName: 'Doe',
    email: 'jane@example.com',
    currentState: 'VISIBLE',
  },
  {
    id: 67890,
    type: 'BUSINESS',
    fullName: 'Acme Corp',
    businessName: 'Acme Corp',
    currentState: 'VISIBLE',
  },
];

export const mockBalances = [
  {
    id: 555001,
    currency: 'GBP',
    type: 'STANDARD',
    name: null,
    investmentState: 'NOT_INVESTED',
    amount: { value: 1250.5, currency: 'GBP' },
    reservedAmount: { value: 0, currency: 'GBP' },
    creationTime: '2025-01-01T00:00:00.000Z',
    modificationTime: '2026-01-01T00:00:00.000Z',
    visible: true,
  },
  {
    id: 555002,
    currency: 'EUR',
    type: 'STANDARD',
    name: null,
    investmentState: 'NOT_INVESTED',
    amount: { value: 300.0, currency: 'EUR' },
    reservedAmount: { value: 12.4, currency: 'EUR' },
    creationTime: '2025-01-01T00:00:00.000Z',
    modificationTime: '2026-01-01T00:00:00.000Z',
    visible: true,
  },
  {
    id: 555003,
    currency: 'GBP',
    type: 'SAVINGS',
    name: 'Holiday fund',
    investmentState: 'NOT_INVESTED',
    amount: { value: 500.0, currency: 'GBP' },
    creationTime: '2025-06-01T00:00:00.000Z',
    modificationTime: '2026-01-01T00:00:00.000Z',
    visible: true,
  },
];

export const mockRates = [
  { rate: 1.17245, source: 'GBP', target: 'EUR', time: '2026-01-15T10:43:31+0000' },
];

export const mockRecipients = [
  {
    id: 777001,
    profileId: 12345,
    name: { fullName: 'John Smith', givenName: 'John', familyName: 'Smith' },
    currency: 'EUR',
    country: 'DE',
    type: 'iban',
    legalEntityType: 'PERSON',
    active: true,
    details: { iban: 'DE89370400440532013000' },
    accountSummary: 'DE89 3704 0044 0532 0130 00',
    longAccountSummary: 'EUR account ending in 3000',
    ownedByCustomer: false,
  },
  {
    id: 777002,
    profileId: 12345,
    name: { fullName: 'Acme Corp', givenName: null, familyName: null },
    currency: 'GBP',
    country: 'GB',
    type: 'sort_code',
    legalEntityType: 'BUSINESS',
    active: true,
    details: { sortCode: '04-00-75', accountNumber: '37778842', legalType: 'BUSINESS' },
    accountSummary: '(04-00-75) 37778842',
    longAccountSummary: 'GBP account ending in 8842',
    ownedByCustomer: true,
  },
];

export const mockRecipientPage = {
  content: mockRecipients,
  seekPositionForNext: null,
  seekPositionForCurrent: null,
  size: 2,
};

export const mockRequirementGroups = [
  {
    type: 'iban',
    title: 'IBAN',
    usageInfo: null,
    fields: [
      {
        name: 'IBAN',
        group: [
          {
            key: 'iban',
            name: 'IBAN',
            type: 'text',
            refreshRequirementsOnChange: false,
            required: true,
            displayFormat: null,
            example: 'DE89370400440532013000',
            minLength: 15,
            maxLength: 34,
            validationRegexp: '\\d{8,30}',
            valuesAllowed: null,
          },
        ],
      },
    ],
  },
];

export const mockQuote = {
  id: '11144c35-9fe8-4c32-b351-0c62b46a9458',
  sourceCurrency: 'GBP',
  targetCurrency: 'EUR',
  sourceAmount: 100.0,
  targetAmount: 116.55,
  payOut: 'BANK_TRANSFER',
  preferredPayIn: null,
  rate: 1.17245,
  rateType: 'FIXED',
  rateExpirationTime: '2026-01-15T11:30:00.000Z',
  profile: 12345,
  status: 'PENDING',
  expirationTime: '2026-01-17T10:30:00.000Z',
  createdTime: '2026-01-15T10:30:00.000Z',
  paymentOptions: [
    {
      disabled: false,
      formattedEstimatedDelivery: 'by Jan 16',
      fee: { transferwise: 1.5, payIn: 0.0, discount: 0, partner: 0, total: 1.5 },
      sourceAmount: 100.0,
      targetAmount: 116.55,
      sourceCurrency: 'GBP',
      targetCurrency: 'EUR',
      payIn: 'BANK_TRANSFER',
      payOut: 'BANK_TRANSFER',
      feePercentage: 0.015,
      disabledReason: null,
    },
  ],
  notices: [],
};

export const mockTransfer = {
  id: 888001,
  user: 999,
  targetAccount: 777001,
  sourceAccount: null,
  quote: null,
  quoteUuid: '11144c35-9fe8-4c32-b351-0c62b46a9458',
  status: 'incoming_payment_waiting',
  rate: 1.17245,
  created: '2026-01-15T10:35:00.000Z',
  details: { reference: 'Invoice 1042' },
  hasActiveIssues: false,
  sourceCurrency: 'GBP',
  sourceValue: 100.0,
  targetCurrency: 'EUR',
  targetValue: 116.55,
  customerTransactionId: '5e3f2b7c-1234-4abc-8def-0123456789ab',
};

export const mockTransfers = [mockTransfer];

export const mockStatement = {
  accountHolder: { type: 'PERSONAL', firstName: 'Jane', lastName: 'Doe' },
  issuer: { name: 'Wise Payments Limited', firstLine: '1 Example Street', city: 'London' },
  bankDetails: null,
  transactions: [
    {
      type: 'CREDIT',
      date: '2026-01-10T09:00:00.000Z',
      amount: { value: 500.0, currency: 'GBP' },
      totalFees: { value: 0, currency: 'GBP' },
      details: {
        type: 'DEPOSIT',
        description: 'Top-up from bank',
        senderName: 'Jane Doe',
        paymentReference: 'P12345678',
      },
      runningBalance: { value: 1250.5, currency: 'GBP' },
      referenceNumber: 'TRANSFER-249281',
    },
    {
      type: 'DEBIT',
      date: '2026-01-12T14:20:00.000Z',
      amount: { value: -25.3, currency: 'GBP' },
      totalFees: { value: 0, currency: 'GBP' },
      details: {
        type: 'CARD',
        description: 'Card transaction',
        merchant: { name: 'Coffee Place Ltd', city: 'London', country: 'GB' },
      },
      runningBalance: { value: 1225.2, currency: 'GBP' },
      referenceNumber: 'CARD-249282',
    },
  ],
  endOfStatementBalance: { value: 1250.5, currency: 'GBP' },
  query: { intervalStart: '2026-01-01T00:00:00.000Z', intervalEnd: '2026-02-01T00:00:00.000Z', currency: 'GBP' },
};

export const mockActivitiesPage = {
  cursor: null,
  activities: [
    {
      id: 'YWN0aXZpdHk6MQ==',
      type: 'TRANSFER',
      resource: { type: 'TRANSFER', id: '888001' },
      title: 'Sent to <strong>John Smith</strong>',
      description: 'Your transfer is on its way',
      primaryAmount: '100 GBP',
      secondaryAmount: '116.55 EUR',
      status: 'IN_PROGRESS',
      createdOn: '2026-01-15T10:35:00.000Z',
      updatedOn: '2026-01-15T10:35:00.000Z',
    },
  ],
};
