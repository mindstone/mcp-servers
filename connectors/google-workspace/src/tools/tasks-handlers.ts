import { getTasksService } from '../modules/tasks/index.js';
import { resolveEmail } from '../utils/account.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { getAccountManager } from '../modules/accounts/index.js';
import { ListTasksOptions } from '../modules/tasks/types.js';
import {
  readAliasedBoolean,
  readAliasedNumber,
  readAliasedString
} from './arg-aliases.js';

// Singleton instances
let tasksService: ReturnType<typeof getTasksService>;
let accountManager: ReturnType<typeof getAccountManager>;

/**
 * Initialize required services
 */
async function initializeServices() {
  if (!tasksService) {
    tasksService = getTasksService();
    await tasksService.ensureInitialized();
  }
  
  if (!accountManager) {
    accountManager = getAccountManager();
  }
}

// ============================================================================
// Handler Parameter Interfaces
// ============================================================================

export interface ListTaskListsParams {
  email?: string;
}

export interface ListTasksParams {
  email?: string;
  task_list_id?: string;
  taskListId?: string;
  max_results?: number;
  maxResults?: number;
  page_token?: string;
  pageToken?: string;
  show_completed?: boolean;
  showCompleted?: boolean;
  show_hidden?: boolean;
  showHidden?: boolean;
  due_min?: string;
  dueMin?: string;
  due_max?: string;
  dueMax?: string;
}

export interface CreateTaskParams {
  email?: string;
  task_list_id?: string;
  taskListId?: string;
  title: string;
  notes?: string;
  due?: string;
}

export interface UpdateTaskParams {
  email?: string;
  task_list_id?: string;
  taskListId?: string;
  task_id?: string;
  taskId: string;
  title?: string;
  notes?: string;
  due?: string;
  status?: 'needsAction' | 'completed';
}

export interface CompleteTaskParams {
  email?: string;
  task_list_id?: string;
  taskListId?: string;
  task_id?: string;
  taskId: string;
}

export interface DeleteTaskParams {
  email?: string;
  task_list_id?: string;
  taskListId?: string;
  task_id?: string;
  taskId: string;
}

// ============================================================================
// Handlers
// ============================================================================

/**
 * List all task lists for a user.
 */
export async function handleListTaskLists(params: ListTaskListsParams) {
  await initializeServices();
  
  const email = await resolveEmail(params);

  return accountManager.withTokenRenewal(email, async () => {
    try {
      const result = await tasksService.listTaskLists(email);
      
      if (!result.success) {
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to list task lists: ${result.error}`
        );
      }

      // Format as human-readable text
      const taskLists = result.data || [];
      if (taskLists.length === 0) {
        return 'No task lists found.';
      }

      const lines: string[] = [];
      lines.push(`Found ${taskLists.length} task list${taskLists.length !== 1 ? 's' : ''}:\n`);
      
      taskLists.forEach((list, i) => {
        lines.push(`${i + 1}. **${list.title}**`);
        lines.push(`   ID: ${list.id}`);
        if (list.updated) {
          lines.push(`   Updated: ${list.updated}`);
        }
        lines.push('');
      });

      lines.push('Tip: Use "@default" as task_list_id for the primary task list.');

      return lines.join('\n');
    } catch (error) {
      if (error instanceof McpError) throw error;
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to list task lists: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  });
}

/**
 * List tasks in a task list.
 */
export async function handleListTasks(params: ListTasksParams) {
  await initializeServices();
  
  const email = await resolveEmail(params);
  const rawParams = params as unknown as Record<string, unknown>;
  const taskListId = readAliasedString(rawParams, 'task_list_id', 'taskListId') || '@default';

  const options: ListTasksOptions = {
    maxResults: readAliasedNumber(rawParams, 'max_results', 'maxResults'),
    pageToken: readAliasedString(rawParams, 'page_token', 'pageToken'),
    showCompleted: readAliasedBoolean(rawParams, 'show_completed', 'showCompleted'),
    showHidden: readAliasedBoolean(rawParams, 'show_hidden', 'showHidden'),
    dueMin: readAliasedString(rawParams, 'due_min', 'dueMin'),
    dueMax: readAliasedString(rawParams, 'due_max', 'dueMax')
  };

  return accountManager.withTokenRenewal(email, async () => {
    try {
      const result = await tasksService.listTasks(email, taskListId, options);
      
      if (!result.success) {
        // Provide actionable error for task list not found
        if (result.error?.includes('not found') || result.error?.includes('404')) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Task list not found: "${taskListId}". Call list_task_lists to see available task lists.`
          );
        }
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to list tasks: ${result.error}`
        );
      }

      const { tasks, nextPageToken } = result.data || { tasks: [], nextPageToken: undefined };
      
      if (tasks.length === 0) {
        return `No tasks found in task list "${taskListId}".`;
      }

      const lines: string[] = [];
      lines.push(`Found ${tasks.length} task${tasks.length !== 1 ? 's' : ''}:\n`);
      
      tasks.forEach((task, i) => {
        const statusIcon = task.status === 'completed' ? '✓' : '○';
        const dueInfo = task.due ? ` (due: ${task.due.split('T')[0]})` : '';
        
        lines.push(`${i + 1}. ${statusIcon} **${task.title}**${dueInfo}`);
        if (task.notes) {
          const truncatedNotes = task.notes.length > 100 
            ? task.notes.substring(0, 100) + '...' 
            : task.notes;
          lines.push(`   Notes: ${truncatedNotes}`);
        }
        lines.push(`   [id: ${task.id}, status: ${task.status}]`);
        lines.push('');
      });

      if (nextPageToken) {
        lines.push(`More tasks available. Use page_token: "${nextPageToken}" to continue.`);
      }

      return lines.join('\n');
    } catch (error) {
      if (error instanceof McpError) throw error;
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to list tasks: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  });
}

/**
 * Create a new task.
 */
export async function handleCreateTask(params: CreateTaskParams) {
  await initializeServices();
  
  const email = await resolveEmail(params);
  const rawParams = params as unknown as Record<string, unknown>;
  const taskListId = readAliasedString(rawParams, 'task_list_id', 'taskListId') || '@default';

  if (!params.title) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Missing required parameter: "title". Example: { "title": "Review PR #123" }'
    );
  }

  return accountManager.withTokenRenewal(email, async () => {
    try {
      const result = await tasksService.createTask(email, taskListId, {
        title: params.title,
        notes: params.notes,
        due: params.due
      });
      
      if (!result.success) {
        if (result.error?.includes('not found') || result.error?.includes('404')) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Task list not found: "${taskListId}". Call list_task_lists to see available task lists.`
          );
        }
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to create task: ${result.error}`
        );
      }

      const task = result.data!;
      const dueInfo = task.due ? `\nDue: ${task.due.split('T')[0]}` : '';
      const notesInfo = task.notes ? `\nNotes: ${task.notes}` : '';
      
      return `Task created successfully!\n\nTitle: ${task.title}${dueInfo}${notesInfo}\nID: ${task.id}\nStatus: ${task.status}`;
    } catch (error) {
      if (error instanceof McpError) throw error;
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to create task: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  });
}

/**
 * Update an existing task.
 */
export async function handleUpdateTask(params: UpdateTaskParams) {
  await initializeServices();
  
  const email = await resolveEmail(params);
  const rawParams = params as unknown as Record<string, unknown>;
  const taskListId = readAliasedString(rawParams, 'task_list_id', 'taskListId') || '@default';
  const taskId = readAliasedString(rawParams, 'task_id', 'taskId');

  if (!taskId) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Missing required parameter: "task_id". Use list_tasks to find task IDs.'
    );
  }

  // Check if any update fields are provided
  if (!params.title && !params.notes && !params.due && !params.status) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'No update fields provided. Specify at least one of: title, notes, due, status'
    );
  }

  return accountManager.withTokenRenewal(email, async () => {
    try {
      const result = await tasksService.updateTask(email, taskListId, taskId, {
        title: params.title,
        notes: params.notes,
        due: params.due,
        status: params.status
      });
      
      if (!result.success) {
        if (result.error?.includes('not found') || result.error?.includes('404')) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Task or task list not found. Verify task_id "${taskId}" exists in list "${taskListId}". ` +
            'Use list_tasks to see available tasks.'
          );
        }
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to update task: ${result.error}`
        );
      }

      const task = result.data!;
      const dueInfo = task.due ? `\nDue: ${task.due.split('T')[0]}` : '';
      const notesInfo = task.notes ? `\nNotes: ${task.notes}` : '';
      
      return `Task updated successfully!\n\nTitle: ${task.title}${dueInfo}${notesInfo}\nID: ${task.id}\nStatus: ${task.status}`;
    } catch (error) {
      if (error instanceof McpError) throw error;
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to update task: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  });
}

/**
 * Mark a task as completed.
 */
export async function handleCompleteTask(params: CompleteTaskParams) {
  await initializeServices();
  
  const email = await resolveEmail(params);
  const rawParams = params as unknown as Record<string, unknown>;
  const taskListId = readAliasedString(rawParams, 'task_list_id', 'taskListId') || '@default';
  const taskId = readAliasedString(rawParams, 'task_id', 'taskId');

  if (!taskId) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Missing required parameter: "task_id". Use list_tasks to find task IDs.'
    );
  }

  return accountManager.withTokenRenewal(email, async () => {
    try {
      const result = await tasksService.updateTask(email, taskListId, taskId, {
        status: 'completed'
      });
      
      if (!result.success) {
        if (result.error?.includes('not found') || result.error?.includes('404')) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Task or task list not found. Verify task_id "${taskId}" exists in list "${taskListId}". ` +
            'Use list_tasks to see available tasks.'
          );
        }
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to complete task: ${result.error}`
        );
      }

      const task = result.data!;
      return `Task completed!\n\nTitle: ${task.title}\nID: ${task.id}\nCompleted: ${task.completed || 'Yes'}`;
    } catch (error) {
      if (error instanceof McpError) throw error;
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to complete task: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  });
}

/**
 * Delete a task.
 */
export async function handleDeleteTask(params: DeleteTaskParams) {
  await initializeServices();
  
  const email = await resolveEmail(params);
  const rawParams = params as unknown as Record<string, unknown>;
  const taskListId = readAliasedString(rawParams, 'task_list_id', 'taskListId') || '@default';
  const taskId = readAliasedString(rawParams, 'task_id', 'taskId');

  if (!taskId) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Missing required parameter: "task_id". Use list_tasks to find task IDs.'
    );
  }

  return accountManager.withTokenRenewal(email, async () => {
    try {
      const result = await tasksService.deleteTask(email, taskListId, taskId);
      
      if (!result.success) {
        if (result.error?.includes('not found') || result.error?.includes('404')) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Task or task list not found. Verify task_id "${taskId}" exists in list "${taskListId}". ` +
            'Use list_tasks to see available tasks.'
          );
        }
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to delete task: ${result.error}`
        );
      }

      return `Task deleted successfully.\n\nTask ID: ${taskId}\nTask List: ${taskListId}`;
    } catch (error) {
      if (error instanceof McpError) throw error;
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to delete task: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  });
}
