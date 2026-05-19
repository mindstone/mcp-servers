import { ToolMetadata } from "../../modules/tools/registry.js";

/**
 * Google Tasks API tool definitions.
 * Following MCP_IMPROVEMENT_WORKFLOW.md design guidelines:
 * - Flat parameters (not nested)
 * - Examples in descriptions
 * - WORKFLOW sections for multi-tool flows
 * - Smart defaults (@default for primary task list)
 */
export const tasksTools: ToolMetadata[] = [
  {
    name: 'list_task_lists',
    category: 'Tasks',
    description: `List all Google Tasks task lists for an account.

Example: { "email": "user@example.com" }

Returns all task lists with their IDs and titles.
The primary task list can also be accessed using "@default" as the task_list_id in other tools.

Use this to discover task list IDs for use with other Tasks tools.`,
    aliases: ['get_task_lists', 'show_task_lists'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Google account email (optional if only one account connected)'
        }
      },
      required: []
    }
  },
  {
    name: 'list_tasks',
    category: 'Tasks',
    description: `List tasks in a Google Tasks list.

Examples:
1. List tasks in primary list: { "email": "user@example.com" }
2. List tasks in specific list: { "email": "user@example.com", "task_list_id": "MTIzNDU2" }
3. List only incomplete tasks: { "email": "user@example.com", "showCompleted": false }
4. List tasks due this week: { "email": "user@example.com", "dueMax": "2026-01-20T23:59:59Z" }

WORKFLOW: Use "@default" (or omit task_list_id) for the primary task list.
Call list_task_lists first to get IDs for other lists.

Returns tasks with id, title, notes, status, due date, and more.`,
    aliases: ['get_tasks', 'show_tasks', 'view_tasks'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Google account email (optional if only one account connected)'
        },
        task_list_id: {
          type: 'string',
          description: 'Task list ID (default: "@default" = primary task list)'
        },
        max_results: {
          type: 'number',
          description: 'Maximum tasks to return (default: 100, max: 100)'
        },
        page_token: {
          type: 'string',
          description: 'Pagination token from previous response'
        },
        showCompleted: {
          type: 'boolean',
          description: 'Include completed tasks (default: true)'
        },
        showHidden: {
          type: 'boolean',
          description: 'Include hidden tasks (default: false)'
        },
        dueMin: {
          type: 'string',
          description: 'Show tasks due on or after this date (RFC 3339 or YYYY-MM-DD)'
        },
        dueMax: {
          type: 'string',
          description: 'Show tasks due on or before this date (RFC 3339 or YYYY-MM-DD)'
        }
      },
      required: []
    }
  },
  {
    name: 'create_task',
    category: 'Tasks',
    description: `Create a new task in Google Tasks.

Examples:
1. Simple task: { "title": "Review PR #123" }
2. Task with details: { "title": "Review PR #123", "notes": "Check error handling", "due": "2026-01-20" }
3. Task in specific list: { "task_list_id": "MTIzNDU2", "title": "Grocery shopping" }

WORKFLOW: Call list_task_lists first to find task_list_id for non-default lists.
Omit task_list_id or use "@default" to add to primary task list.

Returns the created task with its ID for future updates.`,
    aliases: ['add_task', 'new_task'],
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Google account email (optional if only one account connected)'
        },
        task_list_id: {
          type: 'string',
          description: 'Task list ID (default: "@default" = primary task list)'
        },
        title: {
          type: 'string',
          description: 'Task title (required)'
        },
        notes: {
          type: 'string',
          description: 'Task notes/description'
        },
        due: {
          type: 'string',
          description: 'Due date (RFC 3339 or YYYY-MM-DD format)'
        }
      },
      required: ['title']
    }
  },
  {
    name: 'update_task',
    category: 'Tasks',
    description: `Update an existing task in Google Tasks.

Examples:
1. Update title: { "task_list_id": "@default", "task_id": "abc123", "title": "Updated title" }
2. Add due date: { "task_list_id": "@default", "task_id": "abc123", "due": "2026-01-25" }
3. Add notes: { "task_list_id": "@default", "task_id": "abc123", "notes": "Remember to check X" }
4. Mark as needs action: { "task_list_id": "@default", "task_id": "abc123", "status": "needsAction" }

WORKFLOW: 
1. Use list_tasks to find the task_id
2. Call this tool with the task_id and fields to update

Only provided fields are updated; others remain unchanged.
To mark a task complete, use complete_task instead (simpler).`,
    aliases: ['modify_task', 'edit_task'],
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Google account email (optional if only one account connected)'
        },
        task_list_id: {
          type: 'string',
          description: 'Task list ID (default: "@default" = primary task list)'
        },
        task_id: {
          type: 'string',
          description: 'Task ID to update (required)'
        },
        title: {
          type: 'string',
          description: 'New task title'
        },
        notes: {
          type: 'string',
          description: 'New task notes/description'
        },
        due: {
          type: 'string',
          description: 'New due date (RFC 3339 or YYYY-MM-DD format)'
        },
        status: {
          type: 'string',
          enum: ['needsAction', 'completed'],
          description: 'Task status (use complete_task for simpler completion)'
        }
      },
      required: ['task_id']
    }
  },
  {
    name: 'complete_task',
    category: 'Tasks',
    description: `Mark a task as completed in Google Tasks.

Example: { "task_list_id": "@default", "task_id": "abc123" }

This is a convenience wrapper around update_task that sets status to 'completed'.

WORKFLOW:
1. Use list_tasks to find the task_id of the task to complete
2. Call this tool with the task_id

To un-complete a task, use update_task with status: "needsAction".`,
    aliases: ['finish_task', 'done_task', 'check_task'],
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Google account email (optional if only one account connected)'
        },
        task_list_id: {
          type: 'string',
          description: 'Task list ID (default: "@default" = primary task list)'
        },
        task_id: {
          type: 'string',
          description: 'Task ID to mark as completed (required)'
        }
      },
      required: ['task_id']
    }
  },
  {
    name: 'delete_task',
    category: 'Tasks',
    description: `Delete a task from Google Tasks.

Example: { "task_list_id": "@default", "task_id": "abc123" }

WARNING: This permanently deletes the task. It cannot be recovered.

WORKFLOW:
1. Use list_tasks to find the task_id of the task to delete
2. Call this tool with the task_id

Consider using complete_task instead if you just want to mark it done.`,
    aliases: ['remove_task'],
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Google account email (optional if only one account connected)'
        },
        task_list_id: {
          type: 'string',
          description: 'Task list ID (default: "@default" = primary task list)'
        },
        task_id: {
          type: 'string',
          description: 'Task ID to delete (required)'
        }
      },
      required: ['task_id']
    }
  }
];
