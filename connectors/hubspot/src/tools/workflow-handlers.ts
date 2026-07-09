import {
  getHubSpotClientAsync,
  HubSpotApiError,
  WorkflowActionInput
} from '../api/hubspot-client.js';
import { parseHubSpotError, summariseHubSpotApiError } from '../utils/error-parser.js';
import logger from '../utils/logger.js';
import { assertMaxFanOut } from './input-limits.js';

interface ListWorkflowsArgs {
  limit?: number;
}

interface GetWorkflowArgs {
  flowId: string;
}

interface CreateWorkflowArgs {
  name: string;
  type: string;
  actions?: WorkflowActionInput[];
  enrollmentCriteria?: Record<string, unknown>;
}

interface UpdateWorkflowArgs {
  flowId: string;
  name?: string;
  actions?: WorkflowActionInput[];
  enrollmentCriteria?: Record<string, unknown>;
}

interface DeleteWorkflowArgs {
  flowId: string;
  confirm: boolean;
}

interface ToggleWorkflowArgs {
  flowId: string;
}

interface EnrolInWorkflowArgs {
  flowId: string;
  objectIds: string[];
  objectType?: string;
}

export async function handleListWorkflows(args: ListWorkflowsArgs): Promise<unknown> {
  try {
    const client = await getHubSpotClientAsync();
    const result = await client.listWorkflows(args.limit);
    return { workflows: result.results, paging: result.paging };
  } catch (error) {
    const parsed = parseHubSpotError(error, {
      objectType: 'workflows',
      operation: 'list',
      args
    });
    logger.error('Failed to list workflows', parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

export async function handleGetWorkflow(args: GetWorkflowArgs): Promise<unknown> {
  try {
    const client = await getHubSpotClientAsync();
    return await client.getWorkflow(args.flowId);
  } catch (error) {
    const parsed = parseHubSpotError(error, {
      objectType: 'workflows',
      operation: 'get',
      args
    });
    logger.error('Failed to get workflow', parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

export async function handleCreateWorkflow(args: CreateWorkflowArgs): Promise<unknown> {
  try {
    const client = await getHubSpotClientAsync();
    const result = await client.createWorkflow({
      name: args.name,
      type: args.type,
      actions: args.actions,
      enrollmentCriteria: args.enrollmentCriteria
    });

    logger.info(`Created workflow ${result.id}`);
    return result;
  } catch (error) {
    const parsed = parseHubSpotError(error, {
      objectType: 'workflows',
      operation: 'create',
      args
    });
    logger.error('Failed to create workflow', parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

export async function handleUpdateWorkflow(args: UpdateWorkflowArgs): Promise<unknown> {
  try {
    const client = await getHubSpotClientAsync();
    const result = await client.updateWorkflow(args.flowId, {
      name: args.name,
      actions: args.actions,
      enrollmentCriteria: args.enrollmentCriteria
    });

    logger.info(`Updated workflow ${args.flowId}`);
    return result;
  } catch (error) {
    const parsed = parseHubSpotError(error, {
      objectType: 'workflows',
      operation: 'update',
      args
    });
    logger.error('Failed to update workflow', parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

export async function handleDeleteWorkflow(args: DeleteWorkflowArgs): Promise<unknown> {
  if (args.confirm !== true) {
    throw new Error(JSON.stringify({
      error: 'Workflow deletion requires explicit confirmation',
      errorCode: 'CONFIRMATION_REQUIRED',
      suggestion: 'Retry with confirm: true to permanently delete this workflow.'
    }));
  }

  try {
    const client = await getHubSpotClientAsync();
    await client.deleteWorkflow(args.flowId);

    logger.info(`Deleted workflow ${args.flowId}`);
    return {
      success: true,
      message: `Workflow ${args.flowId} deleted`
    };
  } catch (error) {
    const parsed = parseHubSpotError(error, {
      objectType: 'workflows',
      operation: 'delete',
      args
    });
    logger.error('Failed to delete workflow', parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

export async function handleActivateWorkflow(args: ToggleWorkflowArgs): Promise<unknown> {
  try {
    const client = await getHubSpotClientAsync();
    const result = await client.updateWorkflow(args.flowId, { isEnabled: true });

    logger.info(`Activated workflow ${args.flowId}`);
    return result;
  } catch (error) {
    const parsed = parseHubSpotError(error, {
      objectType: 'workflows',
      operation: 'activate',
      args
    });
    logger.error('Failed to activate workflow', parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

export async function handleDeactivateWorkflow(args: ToggleWorkflowArgs): Promise<unknown> {
  try {
    const client = await getHubSpotClientAsync();
    const result = await client.updateWorkflow(args.flowId, { isEnabled: false });

    logger.info(`Deactivated workflow ${args.flowId}`);
    return result;
  } catch (error) {
    const parsed = parseHubSpotError(error, {
      objectType: 'workflows',
      operation: 'deactivate',
      args
    });
    logger.error('Failed to deactivate workflow', parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

export async function handleEnrolInWorkflow(args: EnrolInWorkflowArgs): Promise<unknown> {
  assertMaxFanOut(args.objectIds, 'objectIds');

  try {
    const client = await getHubSpotClientAsync();
    return await client.enrollInWorkflow(args.flowId, args.objectIds, args.objectType || 'contacts');
  } catch (error) {
    // 404 keeps its endpoint-specific hint (portal may need v3 not v4). A 403 is
    // a scope/plan/permission gap — route it through the shared honest, multi-cause
    // copy instead of the old single-cause "reconnect to refresh scopes".
    if (error instanceof HubSpotApiError && error.statusCode === 404) {
      const parsed = {
        error: 'Workflow enrollment via v4 Automation API failed (404)',
        errorCode: 'NOT_FOUND',
        suggestion: 'The workflow could not be found, or your portal may require the v3 workflow enrollment endpoint instead of v4. Verify the workflow ID and try again.',
        details: summariseHubSpotApiError(error, { operation: 'enrol' })
      };
      logger.error('Failed to enrol in workflow', parsed);
      throw new Error(JSON.stringify(parsed));
    }

    const parsed = parseHubSpotError(error, {
      objectType: 'workflows',
      operation: 'enrol',
      args
    });
    logger.error('Failed to enrol in workflow', parsed);
    throw new Error(JSON.stringify(parsed));
  }
}
