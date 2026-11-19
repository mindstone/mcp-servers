import { z } from 'zod';
import type { HubSpotResponseSpec } from './response-parsing.js';

/**
 * Reply schemas for every HubSpot call the client makes. Each requires only
 * identity fields and fields HubSpot documents as always present; everything
 * else is optional, and `.passthrough()` keeps additional vendor fields, so
 * tool output is unchanged by parsing.
 */

function spec<T>(label: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): HubSpotResponseSpec<T> {
  return { label, schema };
}

const PagingSchema = z.object({
  next: z.object({
    after: z.string(),
    link: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();

function listOf<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    results: z.array(item),
    paging: PagingSchema.optional(),
  }).passthrough();
}

const AssociationRefSchema = z.object({
  id: z.string(),
  type: z.string().optional(),
}).passthrough();

export const CrmObjectSchema = z.object({
  id: z.string(),
  properties: z.record(z.string().nullable()),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  archived: z.boolean().optional(),
  associations: z.record(z.object({ results: z.array(AssociationRefSchema) }).passthrough()).optional(),
}).passthrough();
export type CrmObject = z.infer<typeof CrmObjectSchema>;

const CrmObjectListSchema = listOf(CrmObjectSchema);
export type ListResponse<T> = { results: T[]; paging?: z.infer<typeof PagingSchema> };

const BatchCrmObjectSchema = z.object({
  results: z.array(CrmObjectSchema),
  status: z.string().optional(),
}).passthrough();

const AssociationLabelSchema = z.object({
  category: z.enum(['HUBSPOT_DEFINED', 'USER_DEFINED']),
  typeId: z.number(),
  label: z.string().nullable().optional(),
}).passthrough();
export type AssociationLabel = z.infer<typeof AssociationLabelSchema>;

const LabeledAssociationSchema = z.object({
  fromObjectTypeId: z.string().optional(),
  fromObjectId: z.union([z.string(), z.number()]),
  toObjectTypeId: z.string().optional(),
  toObjectId: z.union([z.string(), z.number()]),
  labels: z.array(z.string()).optional(),
}).passthrough();

const WorkflowSummarySchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  type: z.string().optional(),
  isEnabled: z.boolean().optional(),
  insertedAt: z.string().optional(),
  updatedAt: z.string().optional(),
}).passthrough();
export type WorkflowSummary = z.infer<typeof WorkflowSummarySchema>;

const WorkflowDetailSchema = WorkflowSummarySchema.extend({
  actions: z.array(z.object({
    actionId: z.string().optional(),
    actionTypeId: z.string().optional(),
  }).passthrough()).optional(),
  enrollmentCriteria: z.object({}).passthrough().optional(),
}).passthrough();
export type WorkflowDetail = z.infer<typeof WorkflowDetailSchema>;

const PropertyOptionSchema = z.object({
  label: z.string(),
  value: z.string(),
  description: z.string().optional(),
  displayOrder: z.number().optional(),
  hidden: z.boolean().optional(),
}).passthrough();

const PropertySchema = z.object({
  name: z.string(),
  label: z.string().optional(),
  type: z.string().optional(),
  fieldType: z.string().optional(),
  description: z.string().optional(),
  groupName: z.string().optional(),
  displayOrder: z.number().optional(),
  hasUniqueValue: z.boolean().optional(),
  hidden: z.boolean().optional(),
  options: z.array(PropertyOptionSchema).optional(),
}).passthrough();
export type PropertyResponse = z.infer<typeof PropertySchema>;

const PropertyGroupSchema = z.object({
  name: z.string(),
  label: z.string().optional(),
  displayOrder: z.number().optional(),
  archived: z.boolean().optional(),
}).passthrough();
export type PropertyGroup = z.infer<typeof PropertyGroupSchema>;

const OwnerSchema = z.object({
  id: z.string(),
  email: z.string().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  // HubSpot documents `userId: null` for an archived owner.
  userId: z.number().nullish(),
  teams: z.array(z.object({ id: z.string(), name: z.string().optional() }).passthrough()).optional(),
}).passthrough();

const PipelineSchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  displayOrder: z.number().optional(),
  stages: z.array(z.object({
    id: z.string(),
    label: z.string().optional(),
    displayOrder: z.number().optional(),
    metadata: z.record(z.unknown()).optional(),
  }).passthrough()).optional(),
}).passthrough();

const FormSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  formType: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  configuration: z.object({}).passthrough().optional(),
  fieldGroups: z.array(z.unknown()).optional(),
}).passthrough();

const FormSubmissionsSchema = z.object({
  results: z.array(z.object({
    submittedAt: z.union([z.string(), z.number()]).optional(),
    values: z.array(z.object({
      name: z.string().optional(),
      value: z.string().optional(),
    }).passthrough()).optional(),
    pageUrl: z.string().optional(),
  }).passthrough()),
  paging: PagingSchema.optional(),
}).passthrough();

// Analytics v2 replies vary by breakdown and time period (some are keyed by
// date), so only the documented summary fields are typed.
const AnalyticsReportSchema = z.object({
  totals: z.object({}).passthrough().optional(),
  breakdowns: z.array(z.unknown()).optional(),
}).passthrough();

const MarketingEmailSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  subject: z.string().optional(),
  previewText: z.string().optional(),
  state: z.string().optional(),
  type: z.string().optional(),
  templatePath: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  stats: z.object({}).passthrough().optional(),
}).passthrough();

// One statistics aggregate: counters, ratios and breakdowns, all optional.
const EmailStatisticsAggregateSchema = z.object({
  counters: z.record(z.number()).optional(),
  ratios: z.record(z.number()).optional(),
  deviceBreakdown: z.record(z.unknown()).optional(),
  qualifierStats: z.record(z.unknown()).optional(),
}).passthrough();

const EmailStatisticsSchema = z.object({
  aggregate: EmailStatisticsAggregateSchema.optional(),
  campaignAggregations: z.record(EmailStatisticsAggregateSchema).optional(),
  // The IDs of the emails the statistics cover.
  emails: z.array(z.number()).optional(),
}).passthrough();

const ListSummarySchema = z.object({
  listId: z.string(),
  name: z.string().optional(),
  processingType: z.string().optional(),
  objectTypeId: z.string().optional(),
  size: z.number().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
}).passthrough();
export type HubSpotListSummary = z.infer<typeof ListSummarySchema>;

// The Lists API has replied with both `lists` and `results`; one must be
// present, and either is normalised to `results`.
const ListsSchema = z.union([
  z.object({ lists: z.array(ListSummarySchema), paging: PagingSchema.optional() }).passthrough()
    .transform((reply) => ({ results: reply.lists, paging: reply.paging })),
  z.object({ results: z.array(ListSummarySchema), paging: PagingSchema.optional() }).passthrough()
    .transform((reply) => ({ results: reply.results, paging: reply.paging })),
]);

// HubSpot documents the single-list reply as `{ list: {...} }`; the flat form
// is accepted too, so the tool keeps working with either.
const ListDetailSchema = ListSummarySchema.partial().extend({
  list: ListSummarySchema.optional(),
  filterBranch: z.object({}).passthrough().optional(),
}).passthrough().refine(
  (reply) => reply.list !== undefined || reply.listId !== undefined,
  { message: 'list or listId is required' },
);

const ListMembersSchema = z.object({
  results: z.array(z.object({
    recordId: z.string(),
    membershipTimestamp: z.string().optional(),
  }).passthrough()),
  paging: PagingSchema.optional(),
}).passthrough();

const BlogSettingsSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
}).passthrough();
export type BlogSettings = z.infer<typeof BlogSettingsSchema>;

const BlogPostSchema = z.object({
  id: z.string(),
  contentGroupId: z.string().optional(),
  name: z.string().optional(),
}).passthrough();
export type BlogPost = z.infer<typeof BlogPostSchema>;

const SiteSearchSchema = z.object({
  results: z.array(z.object({}).passthrough()),
  total: z.number().optional(),
  limit: z.number().optional(),
  offset: z.number().optional(),
}).passthrough();
export type SiteSearchResponse = z.infer<typeof SiteSearchSchema>;

const GraphQLErrorSchema = z.object({
  message: z.string(),
  extensions: z.object({}).passthrough().optional(),
}).passthrough();

/**
 * A GraphQL reply is either an error reply (a non-empty `errors` list, whose
 * `data` is not read) or a data reply that carries every queried field. An
 * empty or partial envelope matches neither, so it is INVALID_RESPONSE rather
 * than an empty result.
 */
export function graphQLResponseSpec<T>(
  label: string,
  data: z.ZodType<T, z.ZodTypeDef, unknown>,
): HubSpotResponseSpec<{ data?: T | null; errors?: z.infer<typeof GraphQLErrorSchema>[] }> {
  const errorReply = z.object({
    errors: z.array(GraphQLErrorSchema).nonempty(),
    data: z.unknown().optional(),
  }).passthrough().transform(({ data: _data, ...reply }) => reply);
  const dataReply = z.object({
    data,
    errors: z.array(GraphQLErrorSchema).max(0).optional(),
  }).passthrough();
  return spec(label, z.union([errorReply, dataReply]));
}
export type GraphQLResponse<T> = { data?: T | null; errors?: Array<{ message: string }> };

// GraphQL KB article shape.
// Only fields confirmed in HubSpot's official GraphQL KB docs are included.
// hs_slug, hs_language, hs_meta_description are unverified but commonly work;
// hs_url/hs_created/hs_updated do NOT exist — use hs_path instead.
// GraphQL returns every selected field, so each is required; a null value is
// a legitimate empty field.
const KbArticleSchema = z.object({
  hs_id: z.union([z.string(), z.number()]),
  hs_name: z.string().nullable(),
  hs_body: z.string().nullable(),
  hs_path: z.string().nullable(),
  hs_slug: z.string().nullable(),
  hs_language: z.string().nullable(),
  hs_meta_description: z.string().nullable(),
}).passthrough();
export type KbArticle = z.infer<typeof KbArticleSchema>;

export const KbArticleCollectionDataSchema = z.object({
  KB: z.object({
    knowledge_article_collection: z.object({
      total: z.number().nullable(),
      items: z.array(KbArticleSchema).nullable(),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

// A null article is GraphQL's answer for an ID that does not exist.
export const KbArticleSingleDataSchema = z.object({
  KB: z.object({
    knowledge_article: KbArticleSchema.nullable(),
  }).passthrough(),
}).passthrough();

// HubSpot's File object: id, access, archived, createdAt and updatedAt are
// documented as always present; the rest are not.
const HubSpotFileSchema = z.object({
  id: z.string(),
  access: z.string(),
  archived: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  name: z.string().optional(),
  path: z.string().optional(),
  url: z.string().optional(),
  size: z.number().optional(),
  type: z.string().optional(),
}).passthrough();
export type HubSpotFile = z.infer<typeof HubSpotFileSchema>;

const ImportTaskSchema = z.object({
  id: z.string(),
  links: z.unknown().optional(),
}).passthrough();

const ImportStatusSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('COMPLETE'),
    result: HubSpotFileSchema,
    errors: z.array(z.unknown()).optional(),
  }).passthrough(),
  z.object({
    status: z.enum(['PENDING', 'PROCESSING', 'CANCELED']),
    result: HubSpotFileSchema.optional(),
    errors: z.array(z.unknown()).optional(),
  }).passthrough(),
]);

const SignedUrlSchema = z.object({
  url: z.string(),
  name: z.string().optional(),
}).passthrough();

// A message's original content: plain text and the HTML (rich text) form.
const ConversationOriginalContentSchema = z.object({
  text: z.string().optional(),
  richText: z.string().optional(),
  attachments: z.array(z.unknown()).optional(),
}).passthrough();

const ConversationListSchema = listOf(z.object({ id: z.string() }).passthrough());

export const TokenInfoSchema = z.object({
  hub_id: z.number(),
  user: z.string().optional(),
  user_id: z.number().optional(),
  scopes: z.array(z.string()).optional(),
}).passthrough();

/**
 * Methods that return nothing: a bodiless reply (204) is fine, and any body is
 * ignored. Whether a spec accepts a bodiless reply depends on its schema: this
 * one and `workflowEnrollment` (below) do; every other spec requires a body.
 */
export const NoContentResponse = spec('no_content', z.unknown());

export const HubSpotResponses = {
  tokenInfo: spec('token_info', TokenInfoSchema),
  crmObject: spec('crm_object', CrmObjectSchema),
  crmObjectList: spec('crm_object_list', CrmObjectListSchema),
  crmObjectBatch: spec('crm_object_batch', BatchCrmObjectSchema),
  associations: spec('associations', z.object({ results: z.array(AssociationRefSchema) }).passthrough()),
  associationLabels: spec('association_labels', z.object({ results: z.array(AssociationLabelSchema) }).passthrough()),
  labeledAssociation: spec('labeled_association', LabeledAssociationSchema),
  workflowList: spec('workflow_list', listOf(WorkflowSummarySchema)),
  workflow: spec('workflow', WorkflowDetailSchema),
  // The enrollment reply is not documented. Any JSON object or array passes
  // through; a bodiless reply (204 or empty) is an acknowledgement and becomes
  // `{}`, as it was before replies were parsed. Other JSON is still rejected.
  workflowEnrollment: spec('workflow_enrollment', z.union([
    z.object({}).passthrough(),
    z.array(z.unknown()),
    z.undefined().transform((): Record<string, unknown> => ({})),
  ])),
  propertyList: spec('property_list', z.object({ results: z.array(PropertySchema) }).passthrough()),
  property: spec('property', PropertySchema),
  propertyGroupList: spec('property_group_list', z.object({ results: z.array(PropertyGroupSchema) }).passthrough()),
  propertyGroup: spec('property_group', PropertyGroupSchema),
  ownerList: spec('owner_list', listOf(OwnerSchema)),
  owner: spec('owner', OwnerSchema),
  pipelineList: spec('pipeline_list', z.object({ results: z.array(PipelineSchema) }).passthrough()),
  pipeline: spec('pipeline', PipelineSchema),
  formList: spec('form_list', listOf(FormSchema)),
  form: spec('form', FormSchema),
  formSubmissions: spec('form_submissions', FormSubmissionsSchema),
  analyticsReport: spec('analytics_report', AnalyticsReportSchema),
  marketingEmailList: spec('marketing_email_list', listOf(MarketingEmailSchema)),
  marketingEmail: spec('marketing_email', MarketingEmailSchema),
  emailStatistics: spec('email_statistics', EmailStatisticsSchema),
  lists: spec('lists', ListsSchema),
  list: spec('list', ListDetailSchema),
  listMembers: spec('list_members', ListMembersSchema),
  blogSettingsList: spec('blog_settings_list', listOf(BlogSettingsSchema)),
  blogPostList: spec('blog_post_list', listOf(BlogPostSchema)),
  blogPost: spec('blog_post', BlogPostSchema),
  siteSearch: spec('site_search', SiteSearchSchema),
  file: spec('file', HubSpotFileSchema),
  fileUpload: spec('file_upload', HubSpotFileSchema),
  fileImportTask: spec('file_import_task', ImportTaskSchema),
  fileImportStatus: spec('file_import_status', ImportStatusSchema),
  fileSignedUrl: spec('file_signed_url', SignedUrlSchema),
  conversationList: spec('conversation_list', ConversationListSchema),
  conversationContent: spec('conversation_content', ConversationOriginalContentSchema),
} as const;

/** The parsed reply type of one HubSpotResponses entry. */
export type HubSpotReply<K extends keyof typeof HubSpotResponses> =
  (typeof HubSpotResponses)[K] extends HubSpotResponseSpec<infer T> ? T : never;
