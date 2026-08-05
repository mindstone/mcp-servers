/**
 * MSW handlers for the Google Analytics Admin and Data APIs.
 * Used by integration-style tool tests.
 */

import { http, HttpResponse } from 'msw';

const ADMIN_BETA = 'https://analyticsadmin.googleapis.com/v1beta';
const ADMIN_ALPHA = 'https://analyticsadmin.googleapis.com/v1alpha';
const DATA_BETA = 'https://analyticsdata.googleapis.com/v1beta';

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const checkAuth = (request: Request) => {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) {
    return HttpResponse.json(
      { error: { message: 'Missing bearer', status: 'UNAUTHENTICATED' } },
      { status: 401 },
    );
  }
  return null;
};

export function createGoogleHandlers() {
  return [
    http.get(`${ADMIN_BETA}/accountSummaries`, ({ request }) => {
      const err = checkAuth(request);
      if (err) return err;
      return HttpResponse.json({
        accountSummaries: [
          {
            account: 'accounts/100',
            displayName: 'Acme',
            propertySummaries: [
              {
                property: 'properties/200',
                displayName: 'Acme Web',
                propertyType: 'PROPERTY_TYPE_ORDINARY',
                parent: 'accounts/100',
              },
            ],
          },
        ],
      });
    }),

    http.get(new RegExp(`^${escapeRegex(ADMIN_BETA)}/properties/[^/]+$`), ({ request }) => {
      const err = checkAuth(request);
      if (err) return err;
      const id = new URL(request.url).pathname.split('/').pop();
      return HttpResponse.json({
        name: `properties/${id}`,
        displayName: 'Acme Web',
        propertyType: 'PROPERTY_TYPE_ORDINARY',
        parent: 'accounts/100',
        currencyCode: 'USD',
        timeZone: 'Etc/GMT',
        industryCategory: 'TECHNOLOGY',
        serviceLevel: 'GOOGLE_ANALYTICS_STANDARD',
        createTime: '2024-01-01T00:00:00Z',
        updateTime: '2024-06-01T00:00:00Z',
      });
    }),

    http.get(new RegExp(`^${escapeRegex(DATA_BETA)}/properties/[^/]+/metadata$`), ({ request }) => {
      const err = checkAuth(request);
      if (err) return err;
      return HttpResponse.json({
        dimensions: [
          {
            apiName: 'country',
            uiName: 'Country',
            description: 'The country from which user activity originated.',
            category: 'Geography',
          },
          {
            apiName: 'date',
            uiName: 'Date',
            description: 'The date of the event.',
            category: 'Time',
          },
        ],
        metrics: [
          {
            apiName: 'totalUsers',
            uiName: 'Total users',
            description: 'Total number of users.',
            category: 'User',
            type: 'TYPE_INTEGER',
          },
          {
            apiName: 'sessions',
            uiName: 'Sessions',
            description: 'The number of sessions.',
            category: 'Engagement',
            type: 'TYPE_INTEGER',
          },
        ],
      });
    }),

    http.post(new RegExp(`^${escapeRegex(DATA_BETA)}/properties/[^/]+:runReport$`), async ({ request }) => {
      const err = checkAuth(request);
      if (err) return err;
      const body = (await request.json()) as { limit?: string };
      // The estimate call uses limit:'1'; the real call uses the configured limit.
      const isEstimate = body.limit === '1';
      return HttpResponse.json({
        rowCount: 2,
        dimensionHeaders: [{ name: 'country' }],
        metricHeaders: [{ name: 'totalUsers' }, { name: 'sessions' }],
        rows: isEstimate
          ? [
              {
                dimensionValues: [{ value: 'United Kingdom' }],
                metricValues: [{ value: '634' }, { value: '1194' }],
              },
            ]
          : [
              {
                dimensionValues: [{ value: 'United Kingdom' }],
                metricValues: [{ value: '634' }, { value: '1194' }],
              },
              {
                dimensionValues: [{ value: 'United States' }],
                metricValues: [{ value: '628' }, { value: '1437' }],
              },
            ],
      });
    }),

    http.post(new RegExp(`^${escapeRegex(DATA_BETA)}/properties/[^/]+:checkCompatibility$`), ({ request }) => {
      const err = checkAuth(request);
      if (err) return err;
      return HttpResponse.json({
        dimensionCompatibilities: [
          {
            dimensionMetadata: { apiName: 'country' },
            compatibility: 'COMPATIBLE',
          },
        ],
        metricCompatibilities: [
          {
            metricMetadata: { apiName: 'totalUsers' },
            compatibility: 'COMPATIBLE',
          },
        ],
      });
    }),

    http.post(new RegExp(`^${escapeRegex(DATA_BETA)}/properties/[^/]+:runRealtimeReport$`), ({ request }) => {
      const err = checkAuth(request);
      if (err) return err;
      return HttpResponse.json({
        rowCount: 1,
        metricHeaders: [{ name: 'activeUsers' }],
        rows: [{ metricValues: [{ value: '5' }] }],
      });
    }),

    http.get(new RegExp(`^${escapeRegex(ADMIN_BETA)}/properties/[^/]+/customDimensions`), ({ request }) => {
      const err = checkAuth(request);
      if (err) return err;
      return HttpResponse.json({
        customDimensions: [
          {
            name: 'properties/200/customDimensions/1',
            parameterName: 'plan',
            displayName: 'Plan',
            scope: 'USER',
          },
        ],
      });
    }),

    http.get(new RegExp(`^${escapeRegex(ADMIN_BETA)}/properties/[^/]+/customMetrics`), ({ request }) => {
      const err = checkAuth(request);
      if (err) return err;
      return HttpResponse.json({
        customMetrics: [
          {
            name: 'properties/200/customMetrics/1',
            parameterName: 'score',
            displayName: 'Score',
            measurementUnit: 'STANDARD',
          },
        ],
      });
    }),

    http.post(new RegExp(`^${escapeRegex(ADMIN_ALPHA)}/accounts/[^/]+:searchChangeHistoryEvents$`), ({ request }) => {
      const err = checkAuth(request);
      if (err) return err;
      return HttpResponse.json({ changeHistoryEvents: [] });
    }),

    http.get(new RegExp(`^${escapeRegex(ADMIN_BETA)}/properties/[^/]+/dataStreams$`), ({ request }) => {
      const err = checkAuth(request);
      if (err) return err;
      return HttpResponse.json({
        dataStreams: [
          {
            name: 'properties/200/dataStreams/300',
            displayName: 'Acme Web Stream',
            type: 'WEB_DATA_STREAM',
            createTime: '2024-01-01T00:00:00Z',
            webStreamData: {
              defaultUri: 'https://example.com',
              measurementId: 'G-XXXXXXX',
            },
          },
        ],
      });
    }),

    http.get(new RegExp(`^${escapeRegex(ADMIN_ALPHA)}/properties/[^/]+/dataStreams/[^/]+/globalSiteTag$`), ({ request }) => {
      const err = checkAuth(request);
      if (err) return err;
      return HttpResponse.json({
        name: 'properties/200/dataStreams/300/globalSiteTag',
        snippet: '<script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXXXXX"></script>',
      });
    }),

    http.get(new RegExp(`^${escapeRegex(ADMIN_ALPHA)}/properties/[^/]+/bigQueryLinks$`), ({ request }) => {
      const err = checkAuth(request);
      if (err) return err;
      return HttpResponse.json({
        bigQueryLinks: [
          {
            name: 'properties/200/bigQueryLinks/400',
            project: 'acme-analytics-export',
            dailyExportEnabled: true,
            streamingExportEnabled: false,
          },
        ],
      });
    }),
  ];
}
