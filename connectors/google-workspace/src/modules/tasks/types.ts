/**
 * TypeScript interfaces for Google Tasks API
 * Reference: https://developers.google.com/tasks/reference/rest
 */

/**
 * A task list in Google Tasks.
 */
export interface TaskList {
  /** Task list identifier */
  id: string;
  /** Title of the task list */
  title: string;
  /** Last modification time of the task list (RFC 3339) */
  updated?: string;
  /** ETag of the resource */
  etag?: string;
  /** URL pointing to this task list (used to retrieve, update, or delete) */
  selfLink?: string;
}

/**
 * A task in Google Tasks.
 */
export interface Task {
  /** Task identifier */
  id: string;
  /** Title of the task */
  title: string;
  /** Notes describing the task */
  notes?: string;
  /** Status of the task: 'needsAction' or 'completed' */
  status: 'needsAction' | 'completed';
  /** Due date of the task (RFC 3339 timestamp). Only date portion is used. */
  due?: string;
  /** Completion date of the task (RFC 3339 timestamp). Set when status is 'completed'. */
  completed?: string;
  /** Last modification time of the task (RFC 3339) */
  updated?: string;
  /** ETag of the resource */
  etag?: string;
  /** URL pointing to this task (used to retrieve, update, or delete) */
  selfLink?: string;
  /** Parent task identifier (for subtasks) */
  parent?: string;
  /** String indicating the position of the task among its sibling tasks */
  position?: string;
  /** Flag indicating whether the task is hidden (completed tasks in certain views) */
  hidden?: boolean;
  /** Flag indicating whether the task has been deleted */
  deleted?: boolean;
  /** Collection of links related to this task */
  links?: Array<{
    type: string;
    description?: string;
    link: string;
  }>;
}

/**
 * Parameters for creating a task.
 */
export interface CreateTaskParams {
  /** Title of the task (required) */
  title: string;
  /** Notes describing the task */
  notes?: string;
  /** Due date - accepts RFC 3339 timestamp or YYYY-MM-DD format */
  due?: string;
  /** Parent task ID for creating subtasks */
  parent?: string;
  /** Previous sibling task ID for ordering */
  previous?: string;
}

/**
 * Parameters for updating a task.
 */
export interface UpdateTaskParams {
  /** New title for the task */
  title?: string;
  /** New notes for the task */
  notes?: string;
  /** New due date - accepts RFC 3339 timestamp or YYYY-MM-DD format */
  due?: string;
  /** New status: 'needsAction' or 'completed' */
  status?: 'needsAction' | 'completed';
}

/**
 * Options for listing tasks.
 */
export interface ListTasksOptions {
  /** Maximum number of tasks to return (default: 100, max: 100) */
  maxResults?: number;
  /** Token for pagination */
  pageToken?: string;
  /** Include completed tasks (default: true) */
  showCompleted?: boolean;
  /** Include hidden tasks (default: false) */
  showHidden?: boolean;
  /** Include deleted tasks (default: false) */
  showDeleted?: boolean;
  /** RFC 3339 timestamp - tasks completed after this date */
  completedMin?: string;
  /** RFC 3339 timestamp - tasks completed before this date */
  completedMax?: string;
  /** RFC 3339 timestamp - tasks due after this date */
  dueMin?: string;
  /** RFC 3339 timestamp - tasks due before this date */
  dueMax?: string;
  /** RFC 3339 timestamp - tasks last updated after this date */
  updatedMin?: string;
}

/**
 * Result of a task operation.
 */
export interface TaskOperationResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}
