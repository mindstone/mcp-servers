import logger from '../utils/logger.js';
import { refreshTokenForAccount } from '../modules/accounts/oauth.js';
import { deriveHubSpotAccountHash } from '../utils/accountHash.js';

const HUBSPOT_API_BASE = 'https://api.hubapi.com';
const MAX_HUBSPOT_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_HUBSPOT_REQUEST_TIMEOUT_MS = 60_000;

// Buffer time before expiration to trigger refresh (5 minutes)
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export function resolveHubSpotRequestTimeoutMs(envValue = process.env.HUBSPOT_REQUEST_TIMEOUT_MS): number {
  if (!envValue || envValue.trim().length === 0) {
    return DEFAULT_HUBSPOT_REQUEST_TIMEOUT_MS;
  }

  if (!/^\d+$/.test(envValue)) {
    throw new Error(
      `Invalid HUBSPOT_REQUEST_TIMEOUT_MS: "${envValue}". ` +
      `Expected a positive integer in milliseconds (max ${MAX_HUBSPOT_REQUEST_TIMEOUT_MS}).`
    );
  }

  const parsed = Number(envValue);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid HUBSPOT_REQUEST_TIMEOUT_MS: "${envValue}". ` +
      `Expected a positive integer in milliseconds (max ${MAX_HUBSPOT_REQUEST_TIMEOUT_MS}).`
    );
  }

  if (parsed > MAX_HUBSPOT_REQUEST_TIMEOUT_MS) {
    throw new Error(
      `Invalid HUBSPOT_REQUEST_TIMEOUT_MS: "${envValue}". ` +
      `Must be less than or equal to ${MAX_HUBSPOT_REQUEST_TIMEOUT_MS} (5 minutes).`
    );
  }

  return parsed;
}

export function composeHubSpotRequestSignal(
  callerSignal?: AbortSignal,
  envValue = process.env.HUBSPOT_REQUEST_TIMEOUT_MS
): AbortSignal {
  const timeoutMs = resolveHubSpotRequestTimeoutMs(envValue);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
}

export interface HubSpotTokenData {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  expires_at?: number;
  token_type?: string;
  hub_id?: number;
  user?: string;
  grantedScopes?: string[];
  schemaVersion?: number;
}

export interface HubSpotAccount {
  email: string;
  hubId: number;
  portalId?: number;
}

export interface CrmObject {
  id: string;
  properties: Record<string, string | null>;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  associations?: Record<string, { results: Array<{ id: string; type: string }> }>;
}

export interface SearchFilter {
  propertyName: string;
  operator: string;
  value: string | string[];
}

export interface SearchRequest {
  filterGroups?: Array<{ filters: SearchFilter[] }>;
  sorts?: Array<{ propertyName: string; direction: 'ASCENDING' | 'DESCENDING' }>;
  properties?: string[];
  limit?: number;
  after?: string;
}

export interface BatchResponse<T> {
  results: T[];
  status?: string;
}

export interface ListResponse<T> {
  results: T[];
  paging?: {
    next?: {
      after: string;
      link: string;
    };
  };
}

type HubSpotListSummary = {
  listId: string;
  name: string;
  processingType: string;
  objectTypeId: string;
  size?: number;
  createdAt: string;
  updatedAt: string;
};

type HubSpotListsApiResponse = {
  lists?: HubSpotListSummary[];
  results?: HubSpotListSummary[];
  paging?: ListResponse<HubSpotListSummary>['paging'];
};

// v4 Association Labels
export interface AssociationLabel {
  category: 'HUBSPOT_DEFINED' | 'USER_DEFINED';
  typeId: number;
  label: string | null;
}

export interface AssociationSpec {
  associationCategory: 'HUBSPOT_DEFINED' | 'USER_DEFINED';
  associationTypeId: number;
}

// v4 Workflow types (BETA API)
export interface WorkflowSummary {
  id: string;
  name: string;
  type: string;
  isEnabled: boolean;
  insertedAt: string;
  updatedAt: string;
}

export interface WorkflowDetail extends WorkflowSummary {
  actions: Array<{
    actionId: string;
    actionTypeId: string;
    fields?: Record<string, unknown>;
    connection?: {
      nextActionId?: string;
      edgeType?: string;
    };
  }>;
  enrollmentCriteria?: {
    type: string;
    eventFilterBranches?: unknown[];
    shouldReEnroll?: boolean;
  };
}

export interface WorkflowActionInput {
  actionTypeId: string;
  fields?: Record<string, unknown>;
  connection?: {
    nextActionId?: string;
    edgeType?: string;
  };
}

export interface CreateWorkflowRequest {
  name: string;
  type: string;
  actions?: WorkflowActionInput[];
  enrollmentCriteria?: Record<string, unknown>;
}

export interface UpdateWorkflowRequest {
  name?: string;
  actions?: WorkflowActionInput[];
  enrollmentCriteria?: Record<string, unknown>;
  isEnabled?: boolean;
}

export interface PropertyOption {
  label: string;
  value: string;
  description?: string;
  displayOrder?: number;
  hidden?: boolean;
}

export interface PropertyResponse {
  name: string;
  label: string;
  type: string;
  fieldType: string;
  description?: string;
  groupName?: string;
  displayOrder?: number;
  hasUniqueValue?: boolean;
  hidden?: boolean;
  options?: PropertyOption[];
}

export interface PropertyGroup {
  name: string;
  label: string;
  displayOrder?: number;
  archived?: boolean;
}

export interface CreatePropertyRequest {
  name: string;
  label: string;
  type: string;
  fieldType: string;
  groupName: string;
  description?: string;
  options?: PropertyOption[];
}

export interface UpdatePropertyRequest {
  label?: string;
  description?: string;
  options?: PropertyOption[];
}

export interface CreatePropertyGroupRequest {
  name: string;
  label: string;
  displayOrder?: number;
}

export interface BlogSettings {
  id: string;
  name: string;
  publicTitle?: string;
  description?: string;
  slug?: string;
  absoluteUrl?: string;
  language?: string;
  created?: string;
  updated?: string;
}

export interface BlogPost {
  id: string;
  contentGroupId: string;
  name: string;
  htmlTitle?: string;
  postBody?: string;
  slug?: string;
  absoluteUrl?: string;
  state?: string;
  currentState?: string;
  language?: string;
  metaDescription?: string;
  archivedAt?: number;
  archivedInDashboard?: boolean;
  publishDate?: string;
  created?: string;
  updated?: string;
  authorName?: string;
  [key: string]: unknown;
}

export interface CreateBlogPostRequest {
  contentGroupId: string;
  name: string;
  htmlTitle?: string;
  postBody?: string;
  slug?: string;
  metaDescription?: string;
  state?: string;
  language?: string;
  publishDate?: string;
}

export interface UpdateBlogPostRequest {
  name?: string;
  htmlTitle?: string;
  postBody?: string;
  slug?: string;
  metaDescription?: string;
  state?: string;
  language?: string;
  publishDate?: string;
  archivedInDashboard?: boolean;
}

export interface SiteSearchResult {
  id?: string;
  type?: string;
  title?: string;
  url?: string;
  description?: string;
  [key: string]: unknown;
}

export interface SiteSearchResponse {
  results: SiteSearchResult[];
  total?: number;
  limit?: number;
  offset?: number;
  [key: string]: unknown;
}

export interface GraphQLResponse<T = unknown> {
  data?: T;
  errors?: Array<{
    message: string;
    extensions?: Record<string, unknown>;
  }>;
}

export class HubSpotApiError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public details?: unknown
  ) {
    super(message);
    this.name = 'HubSpotApiError';
  }
}

export class HubSpotAuthRequiredError extends Error {
  constructor(
    public readonly reason: 'token_missing' | 'missing_refresh_token' | 'refresh_disabled' | 'invalid_grant',
    public readonly cause?: unknown,
  ) {
    super(`HubSpot authentication required (${reason})`);
    this.name = 'HubSpotAuthRequiredError';
  }
}

export class HubSpotClient {
  private accessToken: string;

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  private async request<T>(
    method: string,
    endpoint: string,
    body?: unknown,
    options?: { signal?: AbortSignal }
  ): Promise<T> {
    const url = `${HUBSPOT_API_BASE}${endpoint}`;
    const signal = composeHubSpotRequestSignal(options?.signal);
    
    logger.debug(`HubSpot API ${method} ${endpoint}`);

    const response = await fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorDetails: unknown = errorText;
      try {
        errorDetails = JSON.parse(errorText);
      } catch {
        // Leave as text for non-JSON error bodies
      }
      
      logger.error(`HubSpot API error: ${response.status}`, errorDetails);
      throw new HubSpotApiError(
        `HubSpot API error: ${response.status} ${response.statusText}`,
        response.status,
        errorDetails
      );
    }

    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  async getTokenInfo(): Promise<{ user: string; hub_id: number; user_id: number }> {
    return this.request('GET', `/oauth/v1/access-tokens/${this.accessToken}`);
  }

  // Generic CRUD operations for any object type
  async createObject(objectType: string, properties: Record<string, string>): Promise<CrmObject> {
    return this.request('POST', `/crm/v3/objects/${objectType}`, { properties });
  }

  async getObject(objectType: string, objectId: string, properties?: string[]): Promise<CrmObject> {
    const params = properties ? `?properties=${properties.join(',')}` : '';
    return this.request('GET', `/crm/v3/objects/${objectType}/${objectId}${params}`);
  }

  async updateObject(objectType: string, objectId: string, properties: Record<string, string>): Promise<CrmObject> {
    return this.request('PATCH', `/crm/v3/objects/${objectType}/${objectId}`, { properties });
  }

  async deleteObject(objectType: string, objectId: string): Promise<void> {
    await this.request('DELETE', `/crm/v3/objects/${objectType}/${objectId}`);
  }

  async listObjects(objectType: string, limit = 10, after?: string, properties?: string[]): Promise<ListResponse<CrmObject>> {
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    if (after) params.set('after', after);
    if (properties) params.set('properties', properties.join(','));
    
    return this.request('GET', `/crm/v3/objects/${objectType}?${params.toString()}`);
  }

  async searchObjects(objectType: string, searchRequest: SearchRequest): Promise<ListResponse<CrmObject>> {
    return this.request('POST', `/crm/v3/objects/${objectType}/search`, searchRequest);
  }

  // Batch operations
  async batchCreateObjects(objectType: string, inputs: Array<{ properties: Record<string, string> }>): Promise<BatchResponse<CrmObject>> {
    return this.request('POST', `/crm/v3/objects/${objectType}/batch/create`, { inputs });
  }

  async batchUpdateObjects(objectType: string, inputs: Array<{ id: string; properties: Record<string, string> }>): Promise<BatchResponse<CrmObject>> {
    return this.request('POST', `/crm/v3/objects/${objectType}/batch/update`, { inputs });
  }

  // Associations
  async createAssociation(
    fromObjectType: string,
    fromObjectId: string,
    toObjectType: string,
    toObjectId: string,
    associationType: string
  ): Promise<void> {
    await this.request(
      'PUT',
      `/crm/v3/objects/${fromObjectType}/${fromObjectId}/associations/${toObjectType}/${toObjectId}/${associationType}`
    );
  }

  async getAssociations(
    fromObjectType: string,
    fromObjectId: string,
    toObjectType: string
  ): Promise<{ results: Array<{ id: string; type: string }> }> {
    return this.request(
      'GET',
      `/crm/v3/objects/${fromObjectType}/${fromObjectId}/associations/${toObjectType}`
    );
  }

  async deleteAssociation(
    fromObjectType: string,
    fromObjectId: string,
    toObjectType: string,
    toObjectId: string,
    associationType: string
  ): Promise<void> {
    await this.request(
      'DELETE',
      `/crm/v3/objects/${fromObjectType}/${fromObjectId}/associations/${toObjectType}/${toObjectId}/${associationType}`
    );
  }

  // v4 Associations (labeled associations)
  async listAssociationLabels(
    fromObjectType: string,
    toObjectType: string
  ): Promise<{ results: AssociationLabel[] }> {
    return this.request('GET', `/crm/v4/associations/${fromObjectType}/${toObjectType}/labels`);
  }

  async createLabeledAssociation(
    fromObjectType: string,
    fromObjectId: string,
    toObjectType: string,
    toObjectId: string,
    associations: AssociationSpec[]
  ): Promise<{ fromObjectTypeId: string; fromObjectId: number; toObjectTypeId: string; toObjectId: number; labels: string[] }> {
    return this.request(
      'PUT',
      `/crm/v4/objects/${fromObjectType}/${fromObjectId}/associations/${toObjectType}/${toObjectId}`,
      associations
    );
  }

  // v4 Workflows (BETA)
  async listWorkflows(limit?: number): Promise<ListResponse<WorkflowSummary>> {
    const params = new URLSearchParams();
    if (limit) params.set('limit', String(limit));
    const query = params.toString();
    return this.request('GET', `/automation/v4/flows${query ? `?${query}` : ''}`);
  }

  async getWorkflow(flowId: string): Promise<WorkflowDetail> {
    return this.request('GET', `/automation/v4/flows/${encodeURIComponent(flowId)}`);
  }

  async createWorkflow(data: CreateWorkflowRequest): Promise<WorkflowDetail> {
    return this.request('POST', '/automation/v4/flows', data);
  }

  async updateWorkflow(flowId: string, data: UpdateWorkflowRequest): Promise<WorkflowDetail> {
    return this.request('PUT', `/automation/v4/flows/${encodeURIComponent(flowId)}`, data);
  }

  async deleteWorkflow(flowId: string): Promise<void> {
    await this.request('DELETE', `/automation/v4/flows/${encodeURIComponent(flowId)}`);
  }

  async enrollInWorkflow(flowId: string, objectIds: string[], objectType = 'contacts'): Promise<unknown> {
    return this.request(
      'POST',
      `/automation/v4/flows/${encodeURIComponent(flowId)}/enrollments/${encodeURIComponent(objectType)}`,
      {
        inputs: objectIds.map(id => ({ id }))
      }
    );
  }

  // Properties
  async listProperties(objectType: string): Promise<{ results: PropertyResponse[] }> {
    return this.request('GET', `/crm/v3/properties/${encodeURIComponent(objectType)}`);
  }

  async getProperty(objectType: string, propertyName: string): Promise<PropertyResponse> {
    return this.request('GET', `/crm/v3/properties/${encodeURIComponent(objectType)}/${encodeURIComponent(propertyName)}`);
  }

  async createProperty(objectType: string, data: CreatePropertyRequest): Promise<PropertyResponse> {
    return this.request('POST', `/crm/v3/properties/${encodeURIComponent(objectType)}`, data);
  }

  async updateProperty(objectType: string, propertyName: string, data: UpdatePropertyRequest): Promise<PropertyResponse> {
    return this.request('PATCH', `/crm/v3/properties/${encodeURIComponent(objectType)}/${encodeURIComponent(propertyName)}`, data);
  }

  async deleteProperty(objectType: string, propertyName: string): Promise<void> {
    await this.request('DELETE', `/crm/v3/properties/${encodeURIComponent(objectType)}/${encodeURIComponent(propertyName)}`);
  }

  async listPropertyGroups(objectType: string): Promise<{ results: PropertyGroup[] }> {
    return this.request('GET', `/crm/v3/properties/${encodeURIComponent(objectType)}/groups`);
  }

  async createPropertyGroup(objectType: string, data: CreatePropertyGroupRequest): Promise<PropertyGroup> {
    return this.request('POST', `/crm/v3/properties/${encodeURIComponent(objectType)}/groups`, data);
  }

  // Owners
  async listOwners(limit = 100, after?: string, email?: string): Promise<ListResponse<{ id: string; email: string; firstName: string; lastName: string; userId: number; teams: Array<{ id: string; name: string }> }>> {
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    if (after) params.set('after', after);
    if (email) params.set('email', email);
    return this.request('GET', `/crm/v3/owners?${params.toString()}`);
  }

  async getOwner(ownerId: string): Promise<{ id: string; email: string; firstName: string; lastName: string; userId: number; teams: Array<{ id: string; name: string }> }> {
    return this.request('GET', `/crm/v3/owners/${ownerId}`);
  }

  // Pipelines
  async listPipelines(objectType: string): Promise<{ results: Array<{ id: string; label: string; displayOrder: number; stages: Array<{ id: string; label: string; displayOrder: number; metadata: Record<string, string> }> }> }> {
    return this.request('GET', `/crm/v3/pipelines/${objectType}`);
  }

  async getPipeline(objectType: string, pipelineId: string): Promise<{ id: string; label: string; displayOrder: number; stages: Array<{ id: string; label: string; displayOrder: number; metadata: Record<string, string> }> }> {
    return this.request('GET', `/crm/v3/pipelines/${objectType}/${pipelineId}`);
  }

  // Engagements (calls, emails, meetings)
  async searchEngagements(engagementType: string, searchRequest: SearchRequest): Promise<ListResponse<CrmObject>> {
    return this.request('POST', `/crm/v3/objects/${engagementType}/search`, searchRequest);
  }

  async getEngagement(engagementType: string, engagementId: string, properties?: string[]): Promise<CrmObject> {
    const params = properties ? `?properties=${properties.join(',')}` : '';
    return this.request('GET', `/crm/v3/objects/${engagementType}/${engagementId}${params}`);
  }

  async createEngagement(engagementType: string, properties: Record<string, string>, associations?: Array<{ to: { id: string }; types: Array<{ associationCategory: string; associationTypeId: number }> }>): Promise<CrmObject> {
    const body: { properties: Record<string, string>; associations?: Array<{ to: { id: string }; types: Array<{ associationCategory: string; associationTypeId: number }> }> } = { properties };
    if (associations) {
      body.associations = associations;
    }
    return this.request('POST', `/crm/v3/objects/${engagementType}`, body);
  }

  async listEngagements(engagementType: string, limit = 10, after?: string, properties?: string[]): Promise<ListResponse<CrmObject>> {
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    if (after) params.set('after', after);
    if (properties) params.set('properties', properties.join(','));
    return this.request('GET', `/crm/v3/objects/${engagementType}?${params.toString()}`);
  }

  // Create object with associations (for line items → deals)
  async createObjectWithAssociations(
    objectType: string,
    properties: Record<string, string>,
    associations?: Array<{ to: { id: string }; types: Array<{ associationCategory: string; associationTypeId: number }> }>
  ): Promise<CrmObject> {
    const body: { properties: Record<string, string>; associations?: typeof associations } = { properties };
    if (associations && associations.length > 0) {
      body.associations = associations;
    }
    return this.request('POST', `/crm/v3/objects/${objectType}`, body);
  }

  // Forms API - Marketing v3
  async listForms(limit = 20, after?: string, formTypes?: string[]): Promise<ListResponse<{ id: string; name: string; formType: string; createdAt: string; updatedAt: string; configuration: Record<string, unknown> }>> {
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    if (after) params.set('after', after);
    if (formTypes && formTypes.length > 0) params.set('formTypes', formTypes.join(','));
    return this.request('GET', `/marketing/v3/forms?${params.toString()}`);
  }

  async getForm(formId: string): Promise<{ id: string; name: string; formType: string; createdAt: string; updatedAt: string; configuration: Record<string, unknown>; fieldGroups: unknown[] }> {
    return this.request('GET', `/marketing/v3/forms/${formId}`);
  }

  async getFormSubmissions(formGuid: string, limit = 20, after?: string): Promise<{ results: Array<{ submittedAt: string; values: Array<{ name: string; value: string }>; pageUrl?: string }>; paging?: { next?: { after: string } } }> {
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    if (after) params.set('after', after);
    return this.request('GET', `/form-integrations/v1/submissions/forms/${formGuid}?${params.toString()}`);
  }

  // Analytics API v2 - Requires Marketing Hub
  async getAnalyticsReport(
    breakdownBy: string,
    timePeriod: string,
    startDate: string,
    endDate: string,
    limit?: number
  ): Promise<{ totals: Record<string, number>; breakdowns: Array<{ breakdown: string; metrics: Record<string, number> }> }> {
    const params = new URLSearchParams();
    params.set('start', startDate);
    params.set('end', endDate);
    if (limit) params.set('limit', String(limit));
    return this.request('GET', `/analytics/v2/reports/${breakdownBy}/${timePeriod}?${params.toString()}`);
  }

  // Marketing Emails API v3
  async listMarketingEmails(limit = 20, after?: string): Promise<ListResponse<{ id: string; name: string; subject: string; state: string; type: string; createdAt: string; stats?: Record<string, number> }>> {
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    if (after) params.set('after', after);
    return this.request('GET', `/marketing/v3/emails?${params.toString()}`);
  }

  async getMarketingEmail(emailId: string): Promise<{ id: string; name: string; subject: string; previewText?: string; state: string; type: string; templatePath?: string; createdAt: string; updatedAt: string; stats?: Record<string, number> }> {
    return this.request('GET', `/marketing/v3/emails/${emailId}`);
  }

  async getEmailStatistics(
    startTimestamp?: string,
    endTimestamp?: string,
    emailIds?: string[]
  ): Promise<{ aggregations: Record<string, number>; emails: Array<{ emailId: string; counters: Record<string, number> }> }> {
    const params = new URLSearchParams();
    if (startTimestamp) params.set('startTimestamp', startTimestamp);
    if (endTimestamp) params.set('endTimestamp', endTimestamp);
    if (emailIds && emailIds.length > 0) params.set('emailIds', emailIds.join(','));
    return this.request('GET', `/marketing/v3/emails/statistics/list?${params.toString()}`);
  }

  // Lists/Segments API v3
  async listLists(limit = 20, after?: string): Promise<ListResponse<HubSpotListSummary>> {
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    if (after) params.set('after', after);
    // HubSpot Lists API v3 returns { lists: [...] } rather than { results: [...] }
    const raw = await this.request<HubSpotListsApiResponse>('GET', `/crm/v3/lists?${params.toString()}`);
    return { results: raw.lists ?? raw.results ?? [], paging: raw.paging };
  }

  async getList(listId: string): Promise<{ listId: string; name: string; processingType: string; objectTypeId: string; filterBranch?: Record<string, unknown>; size?: number; createdAt: string; updatedAt: string }> {
    return this.request('GET', `/crm/v3/lists/${listId}`);
  }

  async getListMembers(listId: string, limit = 100, after?: string): Promise<{ results: Array<{ recordId: string; membershipTimestamp?: string }>; paging?: { next?: { after: string } } }> {
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    if (after) params.set('after', after);
    return this.request('GET', `/crm/v3/lists/${listId}/memberships?${params.toString()}`);
  }

  // CMS Blog / Knowledge Base APIs
  async listBlogSettings(limit?: number, after?: string): Promise<ListResponse<BlogSettings>> {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set('limit', String(limit));
    if (after) params.set('after', after);
    const query = params.toString();
    return this.request('GET', `/cms/v3/blog-settings/settings${query ? `?${query}` : ''}`);
  }

  async listBlogPosts(
    contentGroupId?: string,
    limit?: number,
    after?: string,
    state?: string
  ): Promise<ListResponse<BlogPost>> {
    const params = new URLSearchParams();
    if (contentGroupId) params.set('contentGroupId', contentGroupId);
    if (limit !== undefined) params.set('limit', String(limit));
    if (after) params.set('after', after);
    if (state) params.set('state', state);
    const query = params.toString();
    return this.request('GET', `/cms/v3/blogs/posts${query ? `?${query}` : ''}`);
  }

  async getBlogPost(postId: string): Promise<BlogPost> {
    return this.request('GET', `/cms/v3/blogs/posts/${encodeURIComponent(postId)}`);
  }

  async createBlogPost(data: CreateBlogPostRequest): Promise<BlogPost> {
    return this.request('POST', '/cms/v3/blogs/posts', data);
  }

  async updateBlogPost(postId: string, data: UpdateBlogPostRequest): Promise<BlogPost> {
    return this.request('PATCH', `/cms/v3/blogs/posts/${encodeURIComponent(postId)}`, data);
  }

  async deleteBlogPost(postId: string): Promise<void> {
    await this.request('DELETE', `/cms/v3/blogs/posts/${encodeURIComponent(postId)}`);
  }

  // GraphQL API (used for Knowledge Base article queries)
  async graphqlQuery<T = unknown>(
    query: string,
    variables?: Record<string, unknown>
  ): Promise<GraphQLResponse<T>> {
    return this.request('POST', '/collector/graphql', {
      query,
      variables: variables ?? {},
    });
  }

  async searchSiteContent(
    query: string,
    type?: string,
    limit?: number,
    offset?: number
  ): Promise<SiteSearchResponse> {
    const params = new URLSearchParams();
    params.set('q', query);
    if (type) params.set('type', type);
    if (limit !== undefined) params.set('limit', String(limit));
    if (offset !== undefined) params.set('offset', String(offset));
    return this.request('GET', `/cms/v3/site-search/search?${params.toString()}`);
  }

  // Files API
  async uploadFile(
    fileBuffer: Buffer,
    fileName: string,
    options: { folderPath?: string; access?: 'PUBLIC_INDEXABLE' | 'PUBLIC_NOT_INDEXABLE' | 'PRIVATE' }
  ): Promise<{ id: string; name: string; path: string; url: string; size: number; access: string }> {
    const url = `${HUBSPOT_API_BASE}/files/v3/files`;
    const boundary = `----FormBoundary${Date.now()}`;

    const optionsJson = JSON.stringify({ access: options.access || 'PRIVATE' });
    const folderPath = options.folderPath || '/';

    const parts: Buffer[] = [];
    const enc = (s: string) => Buffer.from(s, 'utf-8');
    const safeFileName = fileName.replace(/["\\]/g, '_').replace(/[\r\n]/g, '');

    // file part
    parts.push(enc(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeFileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
    parts.push(fileBuffer);
    parts.push(enc('\r\n'));

    // options part
    parts.push(enc(`--${boundary}\r\nContent-Disposition: form-data; name="options"\r\n\r\n${optionsJson}\r\n`));

    // folderPath part
    parts.push(enc(`--${boundary}\r\nContent-Disposition: form-data; name="folderPath"\r\n\r\n${folderPath}\r\n`));

    // fileName part
    parts.push(enc(`--${boundary}\r\nContent-Disposition: form-data; name="fileName"\r\n\r\n${fileName}\r\n`));

    parts.push(enc(`--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorDetails: unknown = errorText;
      try { errorDetails = JSON.parse(errorText); } catch { /* keep as text */ }
      throw new HubSpotApiError(`HubSpot API error: ${response.status} ${response.statusText}`, response.status, errorDetails);
    }

    return response.json() as Promise<{ id: string; name: string; path: string; url: string; size: number; access: string }>;
  }

  async importFileFromUrl(
    fileUrl: string,
    options: { folderPath?: string; fileName?: string; access?: 'PUBLIC_INDEXABLE' | 'PUBLIC_NOT_INDEXABLE' | 'PRIVATE' }
  ): Promise<{ id: string; links: Record<string, string>[] }> {
    return this.request('POST', '/files/v3/files/import-from-url/async', {
      url: fileUrl,
      access: options.access || 'PRIVATE',
      folderPath: options.folderPath || '/',
      name: options.fileName,
      duplicateValidationStrategy: 'NONE',
      duplicateValidationScope: 'ENTIRE_PORTAL'
    });
  }

  async getImportStatus(taskId: string): Promise<{
    status: 'PENDING' | 'PROCESSING' | 'COMPLETE' | 'CANCELED';
    result?: { id: string; name: string; path: string; url: string; size: number };
    errors?: unknown[];
  }> {
    return this.request('GET', `/files/v3/files/import-from-url/async/tasks/${taskId}/status`);
  }

  async importFileFromUrlAndWait(
    fileUrl: string,
    options: { folderPath?: string; fileName?: string; access?: 'PUBLIC_INDEXABLE' | 'PUBLIC_NOT_INDEXABLE' | 'PRIVATE' },
    maxWaitMs = 30_000,
    pollIntervalMs = 1_000
  ): Promise<{ id: string; name: string; path: string; url: string; size: number }> {
    const task = await this.importFileFromUrl(fileUrl, options);
    const deadline = Date.now() + maxWaitMs;

    while (Date.now() < deadline) {
      const status = await this.getImportStatus(task.id);
      if (status.status === 'COMPLETE' && status.result) {
        return status.result;
      }
      if (status.status === 'CANCELED') {
        throw new HubSpotApiError(
          `File import was canceled`,
          400,
          status.errors
        );
      }
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
    throw new HubSpotApiError(`File import timed out after ${maxWaitMs}ms (task ${task.id})`, 408);
  }

  async getFile(fileId: string): Promise<{ id: string; name: string; path: string; url: string; size: number; type: string; access: string; createdAt: string; updatedAt: string }> {
    return this.request('GET', `/files/v3/files/${fileId}`);
  }

  async getFileSignedUrl(fileId: string): Promise<{ url: string; name: string }> {
    return this.request('GET', `/files/v3/files/${fileId}/signed-url`);
  }

  async deleteFile(fileId: string): Promise<void> {
    await this.request('DELETE', `/files/v3/files/${fileId}`);
  }

  // Batch Read API (for hydrating list member IDs into full contact records)
  async batchReadContacts(ids: string[], properties?: string[]): Promise<{ results: Array<{ id: string; properties: Record<string, string | null>; createdAt: string; updatedAt: string }> }> {
    const body: { inputs: Array<{ id: string }>; properties?: string[] } = {
      inputs: ids.map(id => ({ id }))
    };
    if (properties && properties.length > 0) {
      body.properties = properties;
    }
    return this.request('POST', '/crm/v3/objects/contacts/batch/read', body);
  }
}

import {
  getAccountManager,
  TokenFileMissingError,
} from '../modules/accounts/manager.js';

let clientInstance: HubSpotClient | null = null;
let currentEmail: string | null = null;

/**
 * Check if token is expired or expiring soon
 */
function isTokenExpired(expiresAt: number | undefined): boolean {
  if (!expiresAt) return true;
  return Date.now() >= expiresAt - TOKEN_EXPIRY_BUFFER_MS;
}

/**
 * Get a HubSpot client with automatic token refresh.
 * If the token is expired, it will be refreshed before returning the client.
 * 
 * In multi-instance mode (one MCP instance per account):
 * - If email is provided and matches the instance account, uses that account
 * - If email is provided but differs from instance account, throws an error
 * - If email is not provided, uses the instance's account (first/only account)
 */
export async function getHubSpotClientAsync(email?: string): Promise<HubSpotClient> {
  const manager = getAccountManager();
  const instanceEmail = await manager.getCurrentAccountEmail();
  
  // In multi-instance mode, reject requests for different accounts
  if (email && email !== instanceEmail) {
    throw new Error(
      `This HubSpot MCP instance is configured for ${instanceEmail}. ` +
      `To access ${email}, use the MCP instance configured for that account.`
    );
  }
  
  const targetEmail = instanceEmail;
  let token: HubSpotTokenData;
  try {
    token = await manager.loadToken(targetEmail);
  } catch (error) {
    if (error instanceof TokenFileMissingError) {
      throw new HubSpotAuthRequiredError('token_missing', error);
    }
    throw error;
  }
  
  if (!token.access_token) {
    throw new HubSpotAuthRequiredError('token_missing');
  }
  
  // Check if token needs refresh
  if (isTokenExpired(token.expires_at)) {
    const refreshResult = await refreshTokenForAccount(targetEmail, token);
    if (refreshResult.status === 'auth_required') {
      if (refreshResult.reason === 'refresh_disabled') {
        throw new HubSpotAuthRequiredError('refresh_disabled');
      }
      if (refreshResult.reason === 'missing_refresh_token') {
        throw new HubSpotAuthRequiredError('missing_refresh_token');
      }
      throw new HubSpotAuthRequiredError('invalid_grant');
    }

    token = refreshResult.token;
    logger.info({ account: deriveHubSpotAccountHash(targetEmail) }, 'token_refreshed');

    if (currentEmail === targetEmail) {
      clientInstance = null;
    }
  }
  
  // Reuse client if same account and token hasn't changed
  if (clientInstance && currentEmail === targetEmail) {
    return clientInstance;
  }
  
  clientInstance = new HubSpotClient(token.access_token);
  currentEmail = targetEmail;
  return clientInstance;
}

// Synchronous version for backward compatibility - throws if no token cached
export function getHubSpotClient(): HubSpotClient {
  if (!clientInstance) {
    throw new Error('HubSpot client not initialized. Call getHubSpotClientAsync first or use list_hubspot_accounts to check connection.');
  }
  return clientInstance;
}

export function setHubSpotClient(client: HubSpotClient): void {
  clientInstance = client;
}
