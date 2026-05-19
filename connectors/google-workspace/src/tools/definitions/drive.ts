import { ToolMetadata } from "../../modules/tools/registry.js";

// Drive Tools
export const driveTools: ToolMetadata[] = [
  {
    name: 'list_drive_files',
    category: 'Drive/Files',
    description: `List files in a Google Drive account with optional filtering.
    
    Returns human-readable text by default. Use return_json: true for structured output.

    Usage examples:
    
    1. List recent files:
       { "email": "user@example.com" }
    
    2. List files in a folder:
       { "email": "user@example.com", "options": { "folderId": "1ABC123xyz", "pageSize": 50 } }
    
    3. Filter by query:
       { "email": "user@example.com", "options": { "query": "mimeType='application/pdf'", "pageSize": 20 } }
    
    4. Get JSON output:
       { "email": "user@example.com", "return_json": true }
    
    Parameters (all inside "options"):
    - folderId: List contents of specific folder
    - query: Drive API query string
    - pageSize: Number of files to return
    - orderBy: Sort order fields`,
    aliases: ['list_files', 'get_files', 'show_files'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Drive account'
        },
        options: {
          type: 'object',
          properties: {
            folderId: {
              type: 'string',
              description: 'Optional folder ID to list contents of'
            },
            query: {
              type: 'string',
              description: 'Custom query string for filtering'
            },
            pageSize: {
              type: 'number',
              description: 'Maximum number of files to return'
            },
            orderBy: {
              type: 'array',
              items: { type: 'string' },
              description: 'Sort order fields'
            },
            fields: {
              type: 'array',
              items: { type: 'string' },
              description: 'Fields to include in response'
            }
          }
        },
        return_json: {
          type: 'boolean',
          description: 'Return structured JSON instead of formatted text (default: false)'
        }
      },
      required: []
    }
  },
  {
    name: 'search_drive_files',
    category: 'Drive/Files',
    description: `Search for files in Google Drive with advanced filtering.
    
    Returns human-readable text by default. Use return_json: true for structured output.

    Usage examples:
    
    1. Search by text content:
       { "email": "user@example.com", "options": { "fullText": "quarterly report" } }
    
    2. Search by file type:
       { "email": "user@example.com", "options": { "mimeType": "application/pdf", "pageSize": 20 } }
    
    3. Search in specific folder:
       { "email": "user@example.com", "options": { "folderId": "1ABC123xyz", "fullText": "budget" } }
    
    4. Combined search:
       { "email": "user@example.com", "options": { "fullText": "meeting notes", "mimeType": "application/vnd.google-apps.document" } }
    
    5. Get JSON output:
       { "email": "user@example.com", "options": { "fullText": "report" }, "return_json": true }
    
    Parameters (all inside "options"):
    - fullText: Text to search in file content
    - mimeType: Filter by file type
    - folderId: Search within folder
    - trashed: Include trashed files (default: false)`,
    aliases: ['search_files', 'find_files', 'query_files'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Drive account'
        },
        options: {
          type: 'object',
          properties: {
            fullText: {
              type: 'string',
              description: 'Full text search query'
            },
            mimeType: {
              type: 'string',
              description: 'Filter by MIME type'
            },
            folderId: {
              type: 'string',
              description: 'Filter by parent folder ID'
            },
            trashed: {
              type: 'boolean',
              description: 'Include trashed files'
            },
            query: {
              type: 'string',
              description: 'Additional query string'
            },
            pageSize: {
              type: 'number',
              description: 'Maximum number of files to return'
            }
          }
        },
        return_json: {
          type: 'boolean',
          description: 'Return structured JSON instead of formatted text (default: false)'
        }
      },
      required: ['options']
    }
  },
  {
    name: 'upload_drive_file',
    category: 'Drive/Files',
    description: `Upload a file to Google Drive.
    
    IMPORTANT: Before uploading:
    1. Verify account access with list_workspace_accounts
    2. Confirm account if multiple exist
    3. Check Drive write permissions
    
    Features:
    - Specify file name and type
    - Place in specific folder
    - Set file metadata
    
    Example Flow:
    1. Check account access
    2. Validate file data
    3. Upload and return file info`,
    aliases: ['upload_file', 'create_file', 'add_file'],
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Drive account'
        },
        options: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Name for the uploaded file'
            },
            content: {
              type: 'string',
              description: 'File content (string or base64)'
            },
            mime_type: {
              type: 'string',
              description: 'MIME type of the file'
            },
            parents: {
              type: 'array',
              items: { type: 'string' },
              description: 'Parent folder IDs'
            }
          },
          required: ['name', 'content']
        }
      },
      required: ['options']
    }
  },
  {
    name: 'download_drive_file',
    category: 'Drive/Files',
    description: `Download a file from Google Drive by its file ID.

WORKFLOW - To download a file:
1. Call search_drive_files or list_drive_files to find the file
2. Find the file ID in the response (shown as "[id: xxxxxx]" in text output)
3. Pass that id as file_id here

Example: { "file_id": "1BxiMVs0XRA5nFMdKvBd..." }

COMMON MISTAKES:
- Don't pass Drive URLs or file names - extract the id from search/list results
- For Google Docs/Sheets/Slides, set mime_type for export (e.g., 'application/pdf')`,
    aliases: ['download_file', 'get_file_content', 'fetch_file'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Drive account'
        },
        file_id: {
          type: 'string',
          description: 'File ID from search_drive_files or list_drive_files (shown as "[id: xxxxxx]" in output)'
        },
        mime_type: {
          type: 'string',
          description: 'Export format for Google Workspace files (e.g., application/pdf)'
        }
      },
      required: ['file_id']
    }
  },
  {
    name: 'create_drive_folder',
    category: 'Drive/Folders',
    description: `Create a new folder in Google Drive.
    
    IMPORTANT: Before creating:
    1. Verify account access with list_workspace_accounts
    2. Confirm account if multiple exist
    3. Check Drive write permissions
    
    Features:
    - Create in root or subfolder
    - Set folder metadata
    
    Example Flow:
    1. Check account access
    2. Validate folder name
    3. Create and return folder info`,
    aliases: ['create_folder', 'new_folder', 'add_folder'],
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Drive account'
        },
        name: {
          type: 'string',
          description: 'Name for the new folder'
        },
        parent_id: {
          type: 'string',
          description: 'Optional parent folder ID'
        }
      },
      required: ['name']
    }
  },
  {
    name: 'update_drive_permissions',
    category: 'Drive/Permissions',
    description: `Update sharing permissions for a Drive file or folder.
    
    IMPORTANT: Before updating:
    1. Verify account access with list_workspace_accounts
    2. Confirm account if multiple exist
    3. Check Drive sharing permissions
    
    Permission Types:
    - User: Share with specific email
    - Group: Share with Google Group
    - Domain: Share with entire domain
    - Anyone: Public sharing
    
    Roles:
    - owner: Full ownership rights
    - organizer: Organizational rights
    - fileOrganizer: File organization rights
    - writer: Edit access
    - commenter: Comment access
    - reader: View access
    
    Example Flow:
    1. Check account access
    2. Validate permission details
    3. Update and return result`,
    aliases: ['share_file', 'update_sharing', 'modify_permissions'],
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Drive account'
        },
        options: {
          type: 'object',
          properties: {
            fileId: {
              type: 'string',
              description: 'ID of file/folder to update'
            },
            role: {
              type: 'string',
              enum: ['owner', 'organizer', 'fileOrganizer', 'writer', 'commenter', 'reader'],
              description: 'Permission role to grant'
            },
            type: {
              type: 'string',
              enum: ['user', 'group', 'domain', 'anyone'],
              description: 'Type of permission'
            },
            emailAddress: {
              type: 'string',
              description: 'Email address for user/group sharing'
            },
            domain: {
              type: 'string',
              description: 'Domain for domain sharing'
            },
            allowFileDiscovery: {
              type: 'boolean',
              description: 'Allow file discovery for anyone sharing'
            }
          },
          required: ['fileId', 'role', 'type']
        }
      },
      required: ['options']
    }
  },
  {
    name: 'delete_drive_file',
    category: 'Drive/Files',
    description: `Permanently delete a file or folder from Google Drive.
    
    WARNING: This permanently deletes the file. It does NOT move to trash.
    Use with caution - deleted files cannot be recovered.
    
    IMPORTANT: Before deleting:
    1. Verify account access with list_workspace_accounts
    2. Confirm account if multiple exist
    3. Check Drive write permissions
    4. Confirm deletion is intended
    
    Example Flow:
    1. Check account access
    2. Validate file exists
    3. Delete and confirm`,
    aliases: ['delete_file', 'remove_file'],
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Drive account'
        },
        file_id: {
          type: 'string',
          description: 'ID of the file/folder to delete'
        }
      },
      required: ['file_id']
    }
  },
  {
    name: 'copy_drive_file',
    category: 'Drive/Files',
    description: `Copy a file in Google Drive, optionally to a different folder.

Example: { "file_id": "abc123", "name": "Copy of Document", "parent_id": "folder456" }

WORKFLOW: Use search_drive_files or list_drive_files to find the file_id first.

If no name is provided, Google Drive will name the copy "Copy of [original name]".
If no parent_id is provided, the copy will be placed in the same folder as the original.`,
    aliases: ['duplicate_file', 'duplicate_drive_file'],
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Drive account'
        },
        file_id: {
          type: 'string',
          description: 'ID of file to copy'
        },
        name: {
          type: 'string',
          description: 'Name for the copy (optional, defaults to "Copy of [original]")'
        },
        parent_id: {
          type: 'string',
          description: 'Folder ID for the copy (optional, defaults to same folder)'
        }
      },
      required: ['file_id']
    }
  },
  {
    name: 'move_drive_file',
    category: 'Drive/Files',
    description: `Move a file to a different folder in Google Drive.

Example: { "file_id": "abc123", "new_parent_id": "folder456" }

WORKFLOW: 
1. Use search_drive_files or list_drive_files to find the file_id
2. Use list_drive_files to find the target folder ID
3. Call this tool with file_id and new_parent_id

IMPORTANT: By default, this MOVES the file (removes from all current folders). 
To ADD to a folder without removing from existing folders, set remove_from_parents to an empty string.`,
    aliases: ['relocate_file', 'move_file'],
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Drive account'
        },
        file_id: {
          type: 'string',
          description: 'ID of file to move'
        },
        new_parent_id: {
          type: 'string',
          description: 'ID of the destination folder'
        },
        remove_from_parents: {
          type: 'string',
          description: 'Parent IDs to remove from, comma-separated. Default: fetches current parents (true move). Set to "" to add to folder without removing.'
        }
      },
      required: ['file_id', 'new_parent_id']
    }
  },
  {
    name: 'trash_drive_file',
    category: 'Drive/Files',
    description: `Move a file to trash in Google Drive (recoverable).

Example: { "file_id": "abc123" }

WORKFLOW: Use search_drive_files or list_drive_files to find the file_id first.

This moves the file to trash where it stays for 30 days before permanent deletion.
Use untrash_drive_file to restore a trashed file.

NOTE: This is different from delete_drive_file which permanently deletes immediately.`,
    aliases: ['trash_file'],
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Drive account'
        },
        file_id: {
          type: 'string',
          description: 'ID of file to trash'
        }
      },
      required: ['file_id']
    }
  },
  {
    name: 'untrash_drive_file',
    category: 'Drive/Files',
    description: `Restore a file from trash in Google Drive.

Example: { "file_id": "abc123" }

WORKFLOW: 
1. Use search_drive_files with { "options": { "trashed": true } } to find trashed files
2. Call this tool with the file_id to restore

The file will be restored to its original location.`,
    aliases: ['restore_file', 'untrash_file', 'restore_drive_file'],
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Drive account'
        },
        file_id: {
          type: 'string',
          description: 'ID of file to restore from trash'
        }
      },
      required: ['file_id']
    }
  },
  {
    name: 'list_file_revisions',
    category: 'Drive/Revisions',
    description: `List version history (revisions) of a file in Google Drive.

Example: { "file_id": "abc123" }

WORKFLOW: Use search_drive_files or list_drive_files to find the file_id first.

Returns revision history with modification times and users.
Use download_file_revision to get content from a specific revision.

NOTE: Google Workspace files (Docs, Sheets, Slides) have different revision behavior than uploaded files.`,
    aliases: ['list_revisions', 'get_file_versions', 'file_history'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Drive account'
        },
        file_id: {
          type: 'string',
          description: 'ID of file to list revisions for'
        }
      },
      required: ['file_id']
    }
  },
  {
    name: 'download_file_revision',
    category: 'Drive/Revisions',
    description: `Download a specific revision (version) of a file from Google Drive.

Example: { "file_id": "abc123", "revision_id": "r456" }

WORKFLOW:
1. Use list_file_revisions to get available revision IDs
2. Call this tool with file_id and the desired revision_id

The file will be saved with "_rev_[revision_id]" appended to the filename.

NOTE: Not all revisions are downloadable. Google Workspace files may require export.
If you want to "restore" a revision, download it and re-upload as a new version.`,
    aliases: ['download_revision', 'get_file_revision'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Drive account'
        },
        file_id: {
          type: 'string',
          description: 'ID of the file'
        },
        revision_id: {
          type: 'string',
          description: 'ID of the revision to download (from list_file_revisions)'
        }
      },
      required: ['file_id', 'revision_id']
    }
  }
];
