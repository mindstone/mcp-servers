import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type jsforce from 'jsforce';
import { withErrorHandling, escapeSOQL, escapeSOQLLike, validateFields, validateAndMergeCustomFields, formatSOQLDate, checkSaveResult, formatVendorErrors, sanitizeRecords, sanitizeExternalData, pickArg } from '../utils.js';
import { withConnection, isSessionExpiredError } from '../client.js';
import { wrapUntrusted } from '../untrusted-content.js';
import { ConnectorError, type SaveResult } from '../types.js';

const STAGE_ORDER_SOURCE = 'salesforce:get_opportunities:stage_order';
const STAGE_ORDER_UNAVAILABLE = "Could not read this org's stage order. Do not move a deal relative to its current stage (next, previous, back, forward) without it: ask the person which stage they mean.";

const opportunityStagesSchema = z.array(z.object({
  ApiName: z.string(),
  IsClosed: z.boolean(),
  IsWon: z.boolean(),
}));
const recordTypesSchema = z.array(z.object({ Id: z.string() }));
// UI API picklist values for one record type, in the org's order.
const recordTypeStagesSchema = z.object({
  values: z.array(z.object({ value: z.string() })),
});

interface StageEntry { name: string; isClosed: boolean; isWon: boolean }

type StageOrder =
  | { stageOrder: StageEntry[]; stageOrderByRecordType?: Record<string, StageEntry[]> }
  | { stageOrder: null; stageOrderUnavailable: string; stageOrderError: string | undefined };

/** A stage list that does not match the org's active stages. */
class StageMetadataError extends Error {}

/**
 * Stage metadata never fails a plain read of deals: Salesforce's own refusals
 * (permission, unsupported object) and unexpected shapes become a named gap.
 * Anything else (expired session, a sign-in that could not be saved, network)
 * is rethrown so it is handled as for any other call.
 */
function isDegradable(error: unknown): boolean {
  const vendorRefusal = error instanceof Error && 'errorCode' in error && !isSessionExpiredError(error);
  return vendorRefusal || error instanceof z.ZodError || error instanceof StageMetadataError;
}

/**
 * The named gap for failed metadata reads. Reads run in parallel, so every
 * failure is checked: one that must propagate wins over a refusal, whichever
 * came first.
 */
function unavailable(errors: unknown[]): StageOrder {
  const fatal = errors.findIndex((error) => !isDegradable(error));
  if (fatal !== -1) throw errors[fatal];
  // Bounded log line: the vendor message is org-authored and stays out of logs.
  console.error('[Salesforce MCP] Opportunity stage order could not be read');
  const [error] = errors;
  const detail = error instanceof z.ZodError ? 'Unexpected stage metadata from Salesforce' : (error as Error).message;
  return { stageOrder: null, stageOrderUnavailable: STAGE_ORDER_UNAVAILABLE, stageOrderError: wrapUntrusted(detail, 'salesforce:get_opportunities:stage_order_error') };
}

/** Thrown when one or more record type stage lists could not be read. */
class RecordTypeStagesError extends Error {
  constructor(readonly errors: unknown[]) { super('Record type stage lists could not be read'); }
}

/** Whether the org has active opportunity record types, which may each follow their own sales process. */
async function hasOpportunityRecordTypes(conn: jsforce.Connection): Promise<boolean> {
  const result = await conn.query("SELECT Id FROM RecordType WHERE SobjectType = 'Opportunity' AND IsActive = true");
  return recordTypesSchema.parse(result.records).length > 0;
}

/** The org's active opportunity stages in its own sort order. */
async function readStages(conn: jsforce.Connection): Promise<StageEntry[]> {
  const result = await conn.query('SELECT ApiName, IsClosed, IsWon FROM OpportunityStage WHERE IsActive = true ORDER BY SortOrder');
  return opportunityStagesSchema.parse(result.records).map((s) => ({ name: s.ApiName, isClosed: s.IsClosed, isWon: s.IsWon }));
}

/**
 * Each record type's own stages, in order, from the UI API: a sales process
 * can skip stages, and API writes are not checked against it.
 */
async function readRecordTypeStages(conn: jsforce.Connection, stages: StageEntry[], recordTypeIds: string[]): Promise<Record<string, StageEntry[]>> {
  const byName = new Map(stages.map((s) => [s.name, s]));
  const settled = await Promise.allSettled(recordTypeIds.map(async (recordTypeId) => {
    const response = await conn.request({ method: 'GET', url: `/ui-api/object-info/Opportunity/picklist-values/${recordTypeId}/StageName` });
    const { values } = recordTypeStagesSchema.parse(response);
    const ordered = values.map(({ value }) => {
      const stage = byName.get(value);
      if (!stage) throw new StageMetadataError(`A stage of record type ${recordTypeId} is not an active opportunity stage`);
      return stage;
    });
    return [recordTypeId, ordered] as const;
  }));
  const errors = settled.flatMap((outcome) => (outcome.status === 'rejected' ? [outcome.reason] : []));
  if (errors.length > 0) throw new RecordTypeStagesError(errors);
  return Object.fromEntries(settled.flatMap((outcome) => (outcome.status === 'fulfilled' ? [outcome.value] : [])));
}

const SALESFORCE_ID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;

function distinctRecordTypeIds(records: unknown[]): string[] {
  const ids = new Set<string>();
  for (const record of records) {
    const id = (record as { RecordTypeId?: unknown }).RecordTypeId;
    if (typeof id === 'string' && SALESFORCE_ID.test(id)) ids.add(id);
  }
  return [...ids];
}

export function registerOpportunityTools(server: McpServer): void {
  server.registerTool(
    'salesforce_get_opportunities',
    {
      description: `Get opportunities. Filters: name_contains, stage, related_account_id, close_date_from, close_date_to. Dates must be YYYY-MM-DD. Max 200 (default: 50). Also returns stageOrder: this org's active stages in its own order ({ name, isClosed, isWon }; name is the API value). When the org has opportunity record types, each record carries RecordTypeId and stageOrderByRecordType gives that record type's stages in order; use it for those deals (a deal with no RecordTypeId follows stageOrder). If the order cannot be read, stageOrder is null and stageOrderUnavailable says so.`,
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).optional().describe('Max results 1-200 (default: 50)'),
        name_contains: z.string().optional().describe('Filter by name'),
        stage: z.string().optional().describe('Filter by stage'),
        status: z.string().optional().describe('Alias of stage.'),
        related_account_id: z.string().optional().describe('Filter by Account ID'),
        account_id: z.string().optional().describe('Alias of related_account_id.'),
        close_date_from: z.string().optional().describe('Closing on/after date (YYYY-MM-DD)'),
        close_date_to: z.string().optional().describe('Closing on/before date (YYYY-MM-DD)'),
        fields: z.array(z.string()).optional().describe('Custom fields'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      return withConnection(undefined, async (conn) => {
        const defaultFields = ['Id', 'Name', 'StageName', 'Amount', 'CloseDate', 'AccountId', 'Probability'];
        const fields = validateFields(args.fields || [], defaultFields);
        const conditions: string[] = [];
        if (args.name_contains) conditions.push(`Name LIKE '%${escapeSOQLLike(args.name_contains)}%'`);
        const stage = pickArg({ stage: args.stage, status: args.status });
        const relatedAccountId = pickArg({ related_account_id: args.related_account_id, account_id: args.account_id });
        if (stage) conditions.push(`StageName = '${escapeSOQL(stage)}'`);
        if (relatedAccountId) conditions.push(`AccountId = '${escapeSOQL(relatedAccountId)}'`);
        if (args.close_date_from) conditions.push(`CloseDate >= ${formatSOQLDate(args.close_date_from, 'close_date_from')}`);
        if (args.close_date_to) conditions.push(`CloseDate <= ${formatSOQLDate(args.close_date_to, 'close_date_to')}`);
        let where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
        const limit = Math.min(Math.max(1, args.limit ?? 50), 200);
        where += ` LIMIT ${limit}`;

        // The stage read runs alongside the record-type check and the deal query; a failure is kept and named after the records are read.
        const settle = <T>(promise: Promise<T>) => promise.then((value) => ({ value }), (error: unknown) => ({ error }));
        const stagesRead = settle(readStages(conn));
        const recordTypes = await settle(hasOpportunityRecordTypes(conn));
        const withRecordTypes = 'value' in recordTypes && recordTypes.value;
        const selected = withRecordTypes && !fields.some((f) => f.toLowerCase() === 'recordtypeid') ? [...fields, 'RecordTypeId'] : fields;
        const [result, stages] = await Promise.all([conn.query(`SELECT ${selected.join(', ')} FROM Opportunity${where}`), stagesRead]);

        let stageOrder: StageOrder;
        if ('error' in recordTypes || 'error' in stages) {
          stageOrder = unavailable([recordTypes, stages].flatMap((read) => ('error' in read ? [read.error] : [])));
        } else {
          const sanitize = (entries: StageEntry[]) => sanitizeExternalData(entries, STAGE_ORDER_SOURCE);
          try {
            const byRecordType = withRecordTypes ? await readRecordTypeStages(conn, stages.value, distinctRecordTypeIds(result.records)) : undefined;
            stageOrder = byRecordType
              ? { stageOrder: sanitize(stages.value), stageOrderByRecordType: Object.fromEntries(Object.entries(byRecordType).map(([id, list]) => [id, sanitize(list)])) }
              : { stageOrder: sanitize(stages.value) };
          } catch (error) {
            stageOrder = unavailable(error instanceof RecordTypeStagesError ? error.errors : [error]);
          }
        }
        return JSON.stringify({ ok: true, records: sanitizeRecords(result.records, 'salesforce:get_opportunities:records'), totalSize: result.totalSize, ...stageOrder });
      });
    }),
  );

  server.registerTool(
    'salesforce_create_opportunity',
    {
      description: `Create an opportunity. Required: name, stage_name, close_date (YYYY-MM-DD). Optional: amount, related_account_id, description, fields.`,
      inputSchema: z.object({
        name: z.string().min(1).describe('Opportunity name (required)'),
        stage_name: z.string().min(1).describe('Stage name (required)'),
        close_date: z.string().min(1).describe('Close date YYYY-MM-DD (required)'),
        amount: z.number().optional().describe('Opportunity amount'),
        related_account_id: z.string().optional().describe('Account ID to associate with'),
        description: z.string().optional().describe('Description'),
        fields: z.record(z.unknown()).optional().describe('Additional/custom fields as key-value pairs'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      formatSOQLDate(args.close_date, 'close_date');
      return withConnection(undefined, async (conn) => {
        const data: Record<string, unknown> = { Name: args.name, StageName: args.stage_name, CloseDate: args.close_date };
        if (args.amount !== undefined) data.Amount = args.amount;
        if (args.related_account_id) data.AccountId = args.related_account_id;
        if (args.description) data.Description = args.description;
        if (args.fields) validateAndMergeCustomFields(data, args.fields);
        const result = await conn.sobject('Opportunity').create(data);
        if (!result.success) throw new ConnectorError('Failed to create opportunity', 'CREATE_ERROR', formatVendorErrors(result.errors));
        return JSON.stringify({ ok: true, status: 'success', object: 'Opportunity', id: result.id, name: args.name });
      });
    }),
  );

  server.registerTool(
    'salesforce_update_opportunity',
    {
      description: `Update an opportunity. Required: id. Updatable: name, stage_name, close_date (YYYY-MM-DD), amount, description, fields. For a relative stage change ("next stage", "previous stage", "move it forward"), take the stage from salesforce_get_opportunities: the deal's record type list in stageOrderByRecordType, or stageOrder when the deal has no RecordTypeId; never guess an order from stage names. Pass the stage's API value (the text inside the untrusted-content envelope) as stage_name. Ask the person instead of updating when that order is unavailable, or when the next stage would close the deal and whether it was won or lost is unclear.`,
      inputSchema: z.object({
        id: z.string().min(1).describe('Salesforce Opportunity ID (required)'),
        name: z.string().optional().describe('Opportunity name'),
        stage_name: z.string().optional().describe("Stage API value, from salesforce_get_opportunities' stage order"),
        close_date: z.string().optional().describe('Close date YYYY-MM-DD'),
        amount: z.number().optional().describe('Amount'),
        description: z.string().optional().describe('Description'),
        fields: z.record(z.unknown()).optional().describe('Additional/custom fields'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      if (args.close_date) formatSOQLDate(args.close_date, 'close_date');
      return withConnection(undefined, async (conn) => {
        const updateData: Record<string, unknown> = { Id: args.id };
        if (args.name) updateData.Name = args.name;
        if (args.stage_name) updateData.StageName = args.stage_name;
        if (args.close_date) updateData.CloseDate = args.close_date;
        if (args.amount !== undefined) updateData.Amount = args.amount;
        if (args.description) updateData.Description = args.description;
        if (args.fields) validateAndMergeCustomFields(updateData, args.fields);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await conn.sobject('Opportunity').update(updateData as any) as unknown as SaveResult;
        checkSaveResult(result, 'Failed to update opportunity');
        return JSON.stringify({ ok: true, status: 'success', object: 'Opportunity', id: args.id });
      });
    }),
  );
}
