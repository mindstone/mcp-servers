import { google, tasks_v1 } from 'googleapis';
import { BaseGoogleService } from '../../services/base/BaseGoogleService.js';
import { TASKS_SCOPES } from './scopes.js';
import {
  TaskList,
  Task,
  CreateTaskParams,
  UpdateTaskParams,
  ListTasksOptions,
  TaskOperationResult
} from './types.js';

/**
 * Service for interacting with Google Tasks API.
 * Follows the pattern established by DriveService.
 */
export class TasksService extends BaseGoogleService<tasks_v1.Tasks> {
  private initialized = false;

  constructor() {
    super({
      serviceName: 'Google Tasks',
      version: 'v1'
    });
  }

  /**
   * Initialize the Tasks service and all dependencies.
   */
  public async initialize(): Promise<void> {
    try {
      await super.initialize();
      this.initialized = true;
    } catch (error) {
      throw this.handleError(error, 'Failed to initialize Tasks service');
    }
  }

  /**
   * Ensure the Tasks service is initialized.
   */
  public async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  /**
   * Check if the service is initialized.
   */
  private checkInitialized(): void {
    if (!this.initialized) {
      throw this.handleError(
        new Error('Tasks service not initialized'),
        'Please ensure the service is initialized before use'
      );
    }
  }

  /**
   * Normalize a date to RFC 3339 format for the Tasks API.
   * Accepts YYYY-MM-DD or RFC 3339 format.
   */
  private normalizeDueDate(date: string): string {
    // If already in RFC 3339 format (contains 'T'), return as-is
    if (date.includes('T')) {
      return date;
    }
    // Convert YYYY-MM-DD to RFC 3339 (midnight UTC)
    return `${date}T00:00:00.000Z`;
  }

  /**
   * List all task lists for a user.
   */
  async listTaskLists(email: string): Promise<TaskOperationResult<TaskList[]>> {
    try {
      await this.ensureInitialized();
      this.checkInitialized();
      await this.validateScopes(email, [TASKS_SCOPES.FULL]);

      const client = await this.getAuthenticatedClient(
        email,
        (auth) => google.tasks({ version: 'v1', auth })
      );

      const response = await client.tasklists.list({
        maxResults: 100
      });

      const taskLists: TaskList[] = (response.data.items || []).map(item => ({
        id: item.id || '',
        title: item.title || '',
        updated: item.updated || undefined,
        etag: item.etag || undefined,
        selfLink: item.selfLink || undefined
      }));

      return {
        success: true,
        data: taskLists
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      };
    }
  }

  /**
   * List tasks in a task list.
   * @param email - The user's email address
   * @param taskListId - The task list ID (default: '@default' for primary list)
   * @param options - Filtering and pagination options
   */
  async listTasks(
    email: string,
    taskListId: string = '@default',
    options: ListTasksOptions = {}
  ): Promise<TaskOperationResult<{ tasks: Task[]; nextPageToken?: string }>> {
    try {
      await this.ensureInitialized();
      this.checkInitialized();
      await this.validateScopes(email, [TASKS_SCOPES.FULL]);

      const client = await this.getAuthenticatedClient(
        email,
        (auth) => google.tasks({ version: 'v1', auth })
      );

      const response = await client.tasks.list({
        tasklist: taskListId,
        maxResults: options.maxResults || 100,
        pageToken: options.pageToken,
        showCompleted: options.showCompleted ?? true,
        showHidden: options.showHidden ?? false,
        showDeleted: options.showDeleted ?? false,
        completedMin: options.completedMin,
        completedMax: options.completedMax,
        dueMin: options.dueMin,
        dueMax: options.dueMax,
        updatedMin: options.updatedMin
      });

      const tasks: Task[] = (response.data.items || []).map(item => ({
        id: item.id || '',
        title: item.title || '',
        notes: item.notes || undefined,
        status: (item.status as 'needsAction' | 'completed') || 'needsAction',
        due: item.due || undefined,
        completed: item.completed || undefined,
        updated: item.updated || undefined,
        etag: item.etag || undefined,
        selfLink: item.selfLink || undefined,
        parent: item.parent || undefined,
        position: item.position || undefined,
        hidden: item.hidden || undefined,
        deleted: item.deleted || undefined,
        links: item.links?.map(link => ({
          type: link.type || '',
          description: link.description || undefined,
          link: link.link || ''
        }))
      }));

      return {
        success: true,
        data: {
          tasks,
          nextPageToken: response.data.nextPageToken || undefined
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      };
    }
  }

  /**
   * Create a new task in a task list.
   * @param email - The user's email address
   * @param taskListId - The task list ID (default: '@default' for primary list)
   * @param params - Task creation parameters
   */
  async createTask(
    email: string,
    taskListId: string = '@default',
    params: CreateTaskParams
  ): Promise<TaskOperationResult<Task>> {
    try {
      await this.ensureInitialized();
      this.checkInitialized();
      await this.validateScopes(email, [TASKS_SCOPES.FULL]);

      const client = await this.getAuthenticatedClient(
        email,
        (auth) => google.tasks({ version: 'v1', auth })
      );

      const requestBody: tasks_v1.Schema$Task = {
        title: params.title,
        notes: params.notes,
        due: params.due ? this.normalizeDueDate(params.due) : undefined
      };

      const response = await client.tasks.insert({
        tasklist: taskListId,
        parent: params.parent,
        previous: params.previous,
        requestBody
      });

      const task: Task = {
        id: response.data.id || '',
        title: response.data.title || '',
        notes: response.data.notes || undefined,
        status: (response.data.status as 'needsAction' | 'completed') || 'needsAction',
        due: response.data.due || undefined,
        completed: response.data.completed || undefined,
        updated: response.data.updated || undefined,
        etag: response.data.etag || undefined,
        selfLink: response.data.selfLink || undefined,
        parent: response.data.parent || undefined,
        position: response.data.position || undefined
      };

      return {
        success: true,
        data: task
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      };
    }
  }

  /**
   * Get a specific task by ID.
   * @param email - The user's email address
   * @param taskListId - The task list ID
   * @param taskId - The task ID
   */
  async getTask(
    email: string,
    taskListId: string,
    taskId: string
  ): Promise<TaskOperationResult<Task>> {
    try {
      await this.ensureInitialized();
      this.checkInitialized();
      await this.validateScopes(email, [TASKS_SCOPES.FULL]);

      const client = await this.getAuthenticatedClient(
        email,
        (auth) => google.tasks({ version: 'v1', auth })
      );

      const response = await client.tasks.get({
        tasklist: taskListId,
        task: taskId
      });

      const task: Task = {
        id: response.data.id || '',
        title: response.data.title || '',
        notes: response.data.notes || undefined,
        status: (response.data.status as 'needsAction' | 'completed') || 'needsAction',
        due: response.data.due || undefined,
        completed: response.data.completed || undefined,
        updated: response.data.updated || undefined,
        etag: response.data.etag || undefined,
        selfLink: response.data.selfLink || undefined,
        parent: response.data.parent || undefined,
        position: response.data.position || undefined
      };

      return {
        success: true,
        data: task
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      };
    }
  }

  /**
   * Update an existing task.
   * @param email - The user's email address
   * @param taskListId - The task list ID
   * @param taskId - The task ID
   * @param params - Fields to update
   */
  async updateTask(
    email: string,
    taskListId: string,
    taskId: string,
    params: UpdateTaskParams
  ): Promise<TaskOperationResult<Task>> {
    try {
      await this.ensureInitialized();
      this.checkInitialized();
      await this.validateScopes(email, [TASKS_SCOPES.FULL]);

      const client = await this.getAuthenticatedClient(
        email,
        (auth) => google.tasks({ version: 'v1', auth })
      );

      // First get the current task to merge with updates
      const currentTask = await client.tasks.get({
        tasklist: taskListId,
        task: taskId
      });

      const requestBody: tasks_v1.Schema$Task = {
        ...currentTask.data,
        title: params.title ?? currentTask.data.title,
        notes: params.notes ?? currentTask.data.notes,
        due: params.due ? this.normalizeDueDate(params.due) : currentTask.data.due,
        status: params.status ?? currentTask.data.status
      };

      const response = await client.tasks.update({
        tasklist: taskListId,
        task: taskId,
        requestBody
      });

      const task: Task = {
        id: response.data.id || '',
        title: response.data.title || '',
        notes: response.data.notes || undefined,
        status: (response.data.status as 'needsAction' | 'completed') || 'needsAction',
        due: response.data.due || undefined,
        completed: response.data.completed || undefined,
        updated: response.data.updated || undefined,
        etag: response.data.etag || undefined,
        selfLink: response.data.selfLink || undefined,
        parent: response.data.parent || undefined,
        position: response.data.position || undefined
      };

      return {
        success: true,
        data: task
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      };
    }
  }

  /**
   * Delete a task.
   * @param email - The user's email address
   * @param taskListId - The task list ID
   * @param taskId - The task ID
   */
  async deleteTask(
    email: string,
    taskListId: string,
    taskId: string
  ): Promise<TaskOperationResult<void>> {
    try {
      await this.ensureInitialized();
      this.checkInitialized();
      await this.validateScopes(email, [TASKS_SCOPES.FULL]);

      const client = await this.getAuthenticatedClient(
        email,
        (auth) => google.tasks({ version: 'v1', auth })
      );

      await client.tasks.delete({
        tasklist: taskListId,
        task: taskId
      });

      return {
        success: true
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      };
    }
  }
}
