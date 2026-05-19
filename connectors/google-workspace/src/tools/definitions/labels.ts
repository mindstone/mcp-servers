import { ToolMetadata } from "../../modules/tools/registry.js";

// Label Management Tools
export const labelTools: ToolMetadata[] = [
  {
    name: 'manage_workspace_label',
    category: 'Gmail/Labels',
    description: `DEPRECATED: Prefer using the individual label tools (list_workspace_labels, get_workspace_label, create_workspace_label, update_workspace_label, delete_workspace_label) instead.\n\nManage Gmail labels with CRUD operations.
    
    IMPORTANT: Before any operation:
    1. Verify account access with list_workspace_accounts
    2. Confirm account if multiple exist
    
    Operations:
    - create: Create a new label
    - read: Get a specific label or list all labels
    - update: Modify an existing label
    - delete: Remove a label
    
    Features:
    - Nested labels: Use "/" (e.g., "Work/Projects")
    - Custom colors: Hex codes (e.g., "#000000")
    - Visibility options: Show/hide in lists
    
    Limitations:
    - Cannot create/modify system labels (INBOX, SENT, SPAM)
    - Label names must be unique
    
    Example Flow:
    1. Check account access
    2. Perform desired operation
    3. Confirm success`,
    aliases: ['manage_label', 'label_operation', 'handle_label'],
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Gmail account'
        },
        action: {
          type: 'string',
          enum: ['create', 'read', 'update', 'delete'],
          description: 'Operation to perform'
        },
        label_id: {
          type: 'string',
          description: 'Label ID (required for read/update/delete). Pass it as `label_id`.'
        },
        data: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Label name (required for create)'
            },
            message_list_visibility: {
              type: 'string',
              enum: ['show', 'hide'],
              description: 'Label visibility in message list'
            },
            label_list_visibility: {
              type: 'string',
              enum: ['labelShow', 'labelHide', 'labelShowIfUnread'],
              description: 'Label visibility in label list'
            },
            color: {
              type: 'object',
              properties: {
                textColor: {
                  type: 'string',
                  description: 'Text color in hex format'
                },
                backgroundColor: {
                  type: 'string',
                  description: 'Background color in hex format'
                }
              }
            }
          }
        }
      },
      required: ['action']
    }
  },
  // Individual Label Operations (preferred over manage_workspace_label)
  {
    name: 'list_workspace_labels',
    category: 'Gmail/Labels',
    description: `List all Gmail labels for an account. Returns both system labels (INBOX, SENT, etc.) and user-created labels.`,
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Gmail account'
        }
      }
    }
  },
  {
    name: 'get_workspace_label',
    category: 'Gmail/Labels',
    description: `Get a specific Gmail label by its ID. Returns label details including name, visibility settings, and color.`,
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Gmail account'
        },
        label_id: {
          type: 'string',
          description: 'The ID of the label to retrieve (`label_id`)'
        }
      },
      required: ['label_id']
    }
  },
  {
    name: 'create_workspace_label',
    category: 'Gmail/Labels',
    description: `Create a new Gmail label. Supports nested labels (use "/" separator, e.g. "Work/Projects"), custom colors, and visibility options. Cannot create system labels.`,
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Gmail account'
        },
        name: {
          type: 'string',
          description: 'Label name (use "/" for nested labels, e.g. "Work/Projects")'
        },
        message_list_visibility: {
          type: 'string',
          enum: ['show', 'hide'],
          description: 'Label visibility in message list'
        },
        label_list_visibility: {
          type: 'string',
          enum: ['labelShow', 'labelHide', 'labelShowIfUnread'],
          description: 'Label visibility in label list'
        },
        color: {
          type: 'object',
          properties: {
            textColor: {
              type: 'string',
              description: 'Text color in hex format'
            },
            backgroundColor: {
              type: 'string',
              description: 'Background color in hex format'
            }
          }
        }
      },
      required: ['name']
    }
  },
  {
    name: 'update_workspace_label',
    category: 'Gmail/Labels',
    description: `Update an existing Gmail label. Can change name, visibility settings, and color. Cannot modify system labels (INBOX, SENT, SPAM).`,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Gmail account'
        },
        label_id: {
          type: 'string',
          description: 'The ID of the label to update (`label_id`)'
        },
        name: {
          type: 'string',
          description: 'New label name'
        },
        message_list_visibility: {
          type: 'string',
          enum: ['show', 'hide'],
          description: 'Label visibility in message list'
        },
        label_list_visibility: {
          type: 'string',
          enum: ['labelShow', 'labelHide', 'labelShowIfUnread'],
          description: 'Label visibility in label list'
        },
        color: {
          type: 'object',
          properties: {
            textColor: {
              type: 'string',
              description: 'Text color in hex format'
            },
            backgroundColor: {
              type: 'string',
              description: 'Background color in hex format'
            }
          }
        }
      },
      required: ['label_id']
    }
  },
  {
    name: 'delete_workspace_label',
    category: 'Gmail/Labels',
    description: `Delete a Gmail label by its ID. This permanently removes the label. Cannot delete system labels (INBOX, SENT, SPAM).`,
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Gmail account'
        },
        label_id: {
          type: 'string',
          description: 'The ID of the label to delete (`label_id`)'
        }
      },
      required: ['label_id']
    }
  },
  {
    name: 'manage_workspace_label_assignment',
    category: 'Gmail/Labels',
    description: `Manage label assignments for Gmail messages.
    
    IMPORTANT: Before assigning:
    1. Verify account access with list_workspace_accounts
    2. Confirm account if multiple exist
    3. Verify message exists
    4. Check label validity
    
    Operations:
    - add: Apply labels to a message
    - remove: Remove labels from a message
    
    Common Use Cases:
    - Apply single label
    - Remove single label
    - Batch modify multiple labels
    - Update system labels (e.g., mark as read)
    
    Example Flow:
    1. Check account access
    2. Verify message and labels exist
    3. Apply requested changes
    4. Confirm modifications`,
    aliases: ['assign_label', 'modify_message_labels', 'change_message_labels'],
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Gmail account'
        },
        action: {
          type: 'string',
          enum: ['add', 'remove'],
          description: 'Whether to add or remove labels'
        },
        message_id: {
          type: 'string',
          description: 'ID of the message to modify'
        },
        label_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of label IDs to add or remove'
        }
      },
      required: ['action', 'message_id', 'label_ids']
    }
  },
  {
    name: 'manage_workspace_label_filter',
    category: 'Gmail/Labels',
    description: `DEPRECATED: Prefer using the individual filter tools (list_workspace_label_filters, create_workspace_label_filter, update_workspace_label_filter, delete_workspace_label_filter) instead.\n\nManage Gmail label filters with CRUD operations.
    
    IMPORTANT: Before any operation:
    1. Verify account access with list_workspace_accounts
    2. Confirm account if multiple exist
    3. Verify label exists for create/update
    4. Validate filter criteria
    
    Operations:
    - create: Create a new filter
    - read: Get filters (all or by label)
    - update: Modify existing filter
    - delete: Remove filter
    
    Filter Capabilities:
    - Match sender(s) and recipient(s)
    - Search subject and content
    - Filter by attachments
    - Size-based filtering
    
    Actions Available:
    - Apply label automatically
    - Mark as important
    - Mark as read
    - Archive message
    
    Criteria Format:
    1. Simple filters:
       - from: Array of email addresses
       - to: Array of email addresses
       - subject: String for exact match
       - hasAttachment: Boolean
    
    2. Complex queries:
       - hasWords: Array of query strings
       - doesNotHaveWords: Array of exclusion strings
    
    Example Flow:
    1. Check account access
    2. Validate criteria
    3. Perform operation
    4. Verify result`,
    aliases: ['manage_filter', 'handle_filter', 'filter_operation'],
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Gmail account'
        },
        action: {
          type: 'string',
          enum: ['create', 'read', 'update', 'delete'],
          description: 'Operation to perform'
        },
        filter_id: {
          type: 'string',
          description: 'Filter ID (required for update/delete). Pass it as `filter_id`.'
        },
        label_id: {
          type: 'string',
          description: 'Label ID (required for create/update). Pass it as `label_id`.'
        },
        data: {
          type: 'object',
          properties: {
            criteria: {
              type: 'object',
              properties: {
                from: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Match sender email addresses'
                },
                to: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Match recipient email addresses'
                },
                subject: {
                  type: 'string',
                  description: 'Match text in subject'
                },
                hasWords: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Match words in message body'
                },
                doesNotHaveWords: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Exclude messages with these words'
                },
                hasAttachment: {
                  type: 'boolean',
                  description: 'Match messages with attachments'
                },
                size: {
                  type: 'object',
                  properties: {
                    operator: {
                      type: 'string',
                      enum: ['larger', 'smaller'],
                      description: 'Size comparison operator'
                    },
                    size: {
                      type: 'number',
                      description: 'Size in bytes'
                    }
                  }
                }
              }
            },
            actions: {
              type: 'object',
              properties: {
                addLabel: {
                  type: 'boolean',
                  description: 'Apply the label'
                },
                markImportant: {
                  type: 'boolean',
                  description: 'Mark as important'
                },
                markRead: {
                  type: 'boolean',
                  description: 'Mark as read'
                },
                archive: {
                  type: 'boolean',
                  description: 'Archive the message'
                }
              },
              required: ['addLabel']
            }
          }
        }
      },
      required: ['action']
    }
  },
  // Individual Label Filter Operations (preferred over manage_workspace_label_filter)
  {
    name: 'list_workspace_label_filters',
    category: 'Gmail/Labels',
    description: `List all Gmail filters, optionally filtered by a specific label ID. Returns filter criteria and actions for each filter.`,
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Gmail account'
        },
        label_id: {
          type: 'string',
          description: 'Optional label ID to filter results by (`label_id`)'
        }
      }
    }
  },
  {
    name: 'create_workspace_label_filter',
    category: 'Gmail/Labels',
    description: `Create a new Gmail filter for a label. Filters can match by sender, recipient, subject, content, attachments, and size. Actions include applying labels, marking as important/read, and archiving.`,
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Gmail account'
        },
        label_id: {
          type: 'string',
          description: 'Label ID to associate with the filter (`label_id`)'
        },
        data: {
          type: 'object',
          properties: {
            criteria: {
              type: 'object',
              properties: {
                from: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Match sender email addresses'
                },
                to: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Match recipient email addresses'
                },
                subject: {
                  type: 'string',
                  description: 'Match text in subject'
                },
                hasWords: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Match words in message body'
                },
                doesNotHaveWords: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Exclude messages with these words'
                },
                hasAttachment: {
                  type: 'boolean',
                  description: 'Match messages with attachments'
                },
                size: {
                  type: 'object',
                  properties: {
                    operator: {
                      type: 'string',
                      enum: ['larger', 'smaller'],
                      description: 'Size comparison operator'
                    },
                    size: {
                      type: 'number',
                      description: 'Size in bytes'
                    }
                  }
                }
              }
            },
            actions: {
              type: 'object',
              properties: {
                addLabel: {
                  type: 'boolean',
                  description: 'Apply the label'
                },
                markImportant: {
                  type: 'boolean',
                  description: 'Mark as important'
                },
                markRead: {
                  type: 'boolean',
                  description: 'Mark as read'
                },
                archive: {
                  type: 'boolean',
                  description: 'Archive the message'
                }
              },
              required: ['addLabel']
            }
          }
        }
      },
      required: ['label_id', 'data']
    }
  },
  {
    name: 'update_workspace_label_filter',
    category: 'Gmail/Labels',
    description: `Update an existing Gmail filter. Can modify filter criteria and/or actions. Use list_workspace_label_filters to find the filter ID first.`,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Gmail account'
        },
        filter_id: {
          type: 'string',
          description: 'The ID of the filter to update (`filter_id`)'
        },
        label_id: {
          type: 'string',
          description: 'The ID of the label to associate with the filter (`label_id`)'
        },
        data: {
          type: 'object',
          properties: {
            criteria: {
              type: 'object',
              properties: {
                from: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Match sender email addresses'
                },
                to: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Match recipient email addresses'
                },
                subject: {
                  type: 'string',
                  description: 'Match text in subject'
                },
                hasWords: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Match words in message body'
                },
                doesNotHaveWords: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Exclude messages with these words'
                },
                hasAttachment: {
                  type: 'boolean',
                  description: 'Match messages with attachments'
                },
                size: {
                  type: 'object',
                  properties: {
                    operator: {
                      type: 'string',
                      enum: ['larger', 'smaller'],
                      description: 'Size comparison operator'
                    },
                    size: {
                      type: 'number',
                      description: 'Size in bytes'
                    }
                  }
                }
              }
            },
            actions: {
              type: 'object',
              properties: {
                addLabel: {
                  type: 'boolean',
                  description: 'Apply the label'
                },
                markImportant: {
                  type: 'boolean',
                  description: 'Mark as important'
                },
                markRead: {
                  type: 'boolean',
                  description: 'Mark as read'
                },
                archive: {
                  type: 'boolean',
                  description: 'Archive the message'
                }
              },
              required: ['addLabel']
            }
          }
        }
      },
      required: ['filter_id', 'label_id']
    }
  },
  {
    name: 'delete_workspace_label_filter',
    category: 'Gmail/Labels',
    description: `Delete a Gmail filter by its ID. This permanently removes the filter. Use list_workspace_label_filters to find the filter ID first.`,
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Gmail account'
        },
        filter_id: {
          type: 'string',
          description: 'The ID of the filter to delete (`filter_id`)'
        }
      },
      required: ['filter_id']
    }
  }
];
