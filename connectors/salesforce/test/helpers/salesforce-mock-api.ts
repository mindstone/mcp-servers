import { http, HttpResponse } from 'msw';

// Mock Salesforce REST API endpoints that jsforce calls under the hood
const SF_INSTANCE = 'https://test.salesforce.com';

export const MOCK_ACCESS_TOKEN = 'mock-sf-access-token-0001';
export const MOCK_INSTANCE_URL = SF_INSTANCE;

function requireAuth(authHeader: string | null): HttpResponse | null {
  if (!authHeader || !authHeader.includes(MOCK_ACCESS_TOKEN)) {
    return HttpResponse.json(
      [{ message: 'Session expired or invalid', errorCode: 'INVALID_SESSION_ID' }],
      { status: 401 },
    );
  }
  return null;
}

export function createSalesforceHandlers() {
  return [
    // OAuth token endpoint
    http.post('https://login.salesforce.com/services/oauth2/token', async () => {
      return HttpResponse.json({
        access_token: MOCK_ACCESS_TOKEN,
        refresh_token: 'mock-refresh-token',
        instance_url: MOCK_INSTANCE_URL,
        issued_at: String(Date.now()),
        id: 'https://login.salesforce.com/id/00D000000000000/005000000000000',
      });
    }),

    // Describe global (for list_objects)
    http.get('*/services/data/*/sobjects', ({ request }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      return HttpResponse.json({
        sobjects: [
          { name: 'Account', label: 'Account', queryable: true, createable: true, updateable: true, custom: false },
          { name: 'Contact', label: 'Contact', queryable: true, createable: true, updateable: true, custom: false },
          { name: 'Invoice__c', label: 'Invoice', queryable: true, createable: true, updateable: true, custom: true },
        ],
      });
    }),

    // Describe object
    http.get('*/services/data/*/sobjects/:objectName/describe', ({ request, params }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      return HttpResponse.json({
        name: params.objectName,
        label: params.objectName as string,
        labelPlural: `${params.objectName as string}s`,
        fields: [
          { name: 'Id', label: 'Record ID', type: 'id', nillable: false, defaultedOnCreate: true, updateable: false, createable: false },
          { name: 'Name', label: 'Name', type: 'string', nillable: false, defaultedOnCreate: false, updateable: true, createable: true },
        ],
        recordTypeInfos: [],
      });
    }),

    // SOQL Query
    http.get('*/services/data/*/query*', ({ request }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      const url = new URL(request.url);
      const soql = url.searchParams.get('q') || '';
      // Return mock data based on FROM clause
      if (soql.includes('FROM Contact')) {
        return HttpResponse.json({
          totalSize: 1,
          done: true,
          records: [{ Id: '003000000000001', FirstName: 'Jane', LastName: 'Doe', Email: 'jane@acme.com', Phone: '555-0100', Title: 'VP Sales', AccountId: '001000000000001', attributes: { type: 'Contact' } }],
        });
      }
      if (soql.includes('FROM Account')) {
        return HttpResponse.json({
          totalSize: 1,
          done: true,
          records: [{ Id: '001000000000001', Name: 'Acme Corp', Industry: 'Technology', Type: 'Customer', attributes: { type: 'Account' } }],
        });
      }
      if (soql.includes('FROM Opportunity')) {
        return HttpResponse.json({
          totalSize: 1,
          done: true,
          records: [{ Id: '006000000000001', Name: 'Big Deal', StageName: 'Prospecting', Amount: 50000, CloseDate: '2026-12-31', attributes: { type: 'Opportunity' } }],
        });
      }
      if (soql.includes('FROM Lead')) {
        return HttpResponse.json({
          totalSize: 1,
          done: true,
          records: [{ Id: '00Q000000000001', FirstName: 'Bob', LastName: 'Smith', Company: 'Test Inc', Email: 'bob@test.com', attributes: { type: 'Lead' } }],
        });
      }
      if (soql.includes('FROM Task')) {
        return HttpResponse.json({
          totalSize: 1,
          done: true,
          records: [{ Id: '00T000000000001', Subject: 'Follow up', Status: 'Not Started', Priority: 'Normal', attributes: { type: 'Task' } }],
        });
      }
      if (soql.includes('FROM Case')) {
        return HttpResponse.json({
          totalSize: 1,
          done: true,
          records: [{ Id: '500000000000001', CaseNumber: '00001001', Subject: 'Login issue', Status: 'New', Priority: 'Medium', attributes: { type: 'Case' } }],
        });
      }
      if (soql.includes('FROM Event')) {
        return HttpResponse.json({
          totalSize: 1,
          done: true,
          records: [{ Id: '00U000000000001', Subject: 'Quarterly review', StartDateTime: '2026-08-10T14:00:00.000Z', EndDateTime: '2026-08-10T15:00:00.000Z', attributes: { type: 'Event' } }],
        });
      }
      if (soql.includes('FROM User')) {
        return HttpResponse.json({
          totalSize: 1,
          done: true,
          records: [{ Id: '005000000000001', Name: 'Admin User', Email: 'admin@test.com', Username: 'admin@test.com', IsActive: true, attributes: { type: 'User' } }],
        });
      }
      return HttpResponse.json({ totalSize: 0, done: true, records: [] });
    }),

    // Create records (POST to sobject)
    http.post('*/services/data/*/sobjects/:objectName', async ({ request, params }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      const body = await request.json() as Record<string, unknown>;
      return HttpResponse.json({
        id: `mock-${(params.objectName as string).toLowerCase()}-001`,
        success: true,
        errors: [],
      }, { status: 201 });
    }),

    // Update records (PATCH to sobject/id)
    http.patch('*/services/data/*/sobjects/:objectName/:id', async ({ request }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      return new HttpResponse(null, { status: 204 });
    }),

    // SOAP endpoint for lead conversion
    http.post('*/services/Soap/u/*', async ({ request }) => {
      const authErr = requireAuth(request.headers.get('authorization'));
      if (authErr) return authErr;
      return HttpResponse.xml(`<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <convertLeadResponse>
      <result>
        <success>true</success>
        <accountId>001000000000001</accountId>
        <contactId>003000000000001</contactId>
      </result>
    </convertLeadResponse>
  </soapenv:Body>
</soapenv:Envelope>`);
    }),
  ];
}
