import {
  getHubSpotClientAsync,
  HubSpotApiError,
  WorkflowActionInput
} from '../api/hubspot-client.js';
import { parseHubSpotError } from '../utils/error-parser.js';
import logger from '../utils/logger.js';

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
    logger.error('Failed to list workflows', { args, error });
    const parsed = parseHubSpotError(error, {
      objectType: 'workflows',
      operation: 'list',
      args
    });
    throw new Error(JSON.stringify(parsed));
  }
}

export async function handleGetWorkflow(args: GetWorkflowArgs): Promise<unknown> {
  try {
    const client = await getHubSpotClientAsync();
    return await client.getWorkflow(args.flowId);
  } catch (error) {
    logger.error('Failed to get workflow', { args, error });
    const parsed = parseHubSpotError(error, {
      objectType: 'workflows',
      operation: 'get',
      args
    });
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
    logger.error('Failed to create workflow', { args, error });
    const parsed = parseHubSpotError(error, {
      objectType: 'workflows',
      operation: 'create',
      args
    });
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
    logger.error('Failed to update workflow', { args, error });
    const parsed = parseHubSpotError(error, {
      objectType: 'workflows',
      operation: 'update',
      args
    });
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
    logger.error('Failed to delete workflow', { args, error });
    const parsed = parseHubSpotError(error, {
      objectType: 'workflows',
      operation: 'delete',
      args
    });
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
    logger.error('Failed to activate workflow', { args, error });
    const parsed = parseHubSpotError(error, {
      objectType: 'workflows',
      operation: 'activate',
      args
    });
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
    logger.error('Failed to deactivate workflow', { args, error });
    const parsed = parseHubSpotError(error, {
      objectType: 'workflows',
      operation: 'deactivate',
      args
    });
    throw new Error(JSON.stringify(parsed));
  }
}

export async function handleEnrolInWorkflow(args: EnrolInWorkflowArgs): Promise<unknown> {
  try {
    const client = await getHubSpotClientAsync();
    return await client.enrollInWorkflow(args.flowId, args.objectIds, args.objectType || 'contacts');
  } catch (error) {
    logger.error('Failed to enrol in workflow', { args, error });

    if (error instanceof HubSpotApiError && (error.statusCode === 403 || error.statusCode === 404)) {
      throw new Error(JSON.stringify({
        error: `Workflow enrollment via v4 Automation API failed (${error.statusCode})`,
        errorCode: error.statusCode === 403 ? 'SCOPE_MISSING' : 'NOT_FOUND',
        suggestion: 'Reconnect HubSpot to refresh automation scopes. If this persists, your portal may require the v3 workflow enrollment endpoint instead of v4.',
        details: error.details
      }));
    }

    const parsed = parseHubSpotError(error, {
      objectType: 'workflows',
      operation: 'enrol',
      args
    });
    throw new Error(JSON.stringify(parsed));
  }
}
