import { ToolMetadata } from "../../modules/tools/registry.js";

const TAB_LINK_NOTE = 'A Docs link containing ?tab=t.xxxx points at one tab; "t.xxxx" is its tab_id.';

// Google Docs Tools
export const docsTools: ToolMetadata[] = [
  {
    name: 'read_workspace_document',
    category: 'Docs/Documents',
    description: `Read content from a Google Docs document.

    Returns human-readable text by default. Use return_json: true for the raw Google Docs API response.

    Tabs: without tab_id or all_tabs this reads the first tab only. On a document with several
    tabs the result says how many there are and which one is shown. Pass tab_id to read one tab
    (sub-tabs are separate tabs), or all_tabs: true to read every tab in order under
    "## Tab: <path> [tabId: …]" headings; all tabs share one max_chars budget, and tabs past the
    budget are listed by id so you can read them with tab_id. On tab_id / all_tabs reads, smart
    chips, people and dates appear as their text. ${TAB_LINK_NOTE}

    Usage examples:
    
    1. Simple read:
       { "email": "user@example.com", "document_id": "1ABC123xyz" }
    
    2. With character limit:
       { "email": "user@example.com", "document_id": "1ABC123xyz", "max_chars": 10000 }
    
    3. Get raw JSON structure:
       { "email": "user@example.com", "document_id": "1ABC123xyz", "return_json": true }

    4. Read one tab:
       { "email": "user@example.com", "document_id": "1ABC123xyz", "tab_id": "t.abc123" }

    5. Read every tab:
       { "email": "user@example.com", "document_id": "1ABC123xyz", "all_tabs": true }
    
    Response includes:
    - Document title and URL
    - Text content (default: up to 50,000 characters)
    - Truncation indicator if content exceeds limit
    
    Note: For very large documents, consider using max_chars to limit response size.
    all_tabs cannot be combined with return_json; tab_id with return_json returns that one tab
    (up to 100,000 characters of JSON; sub-tabs listed by id).`,
    aliases: ['read_doc', 'get_document', 'view_document'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Google account'
        },
        document_id: {
          type: 'string',
          description: 'Google Docs document ID (from URL or extract_workspace_document_id)'
        },
        max_chars: {
          type: 'number',
          description: 'Maximum characters to return (default: 50000). With all_tabs, one budget shared by all tabs.'
        },
        return_json: {
          type: 'boolean',
          description: 'Return raw Google Docs API JSON instead of formatted text (default: false)'
        },
        tab_id: {
          type: 'string',
          description: 'Tab id from list_workspace_document_tabs. "default" means the first tab.'
        },
        all_tabs: {
          type: 'boolean',
          description: 'Read every tab, in tree order (default: false). Not with tab_id or return_json.'
        }
      },
      required: ['document_id']
    }
  },
  {
    name: 'create_workspace_document',
    category: 'Docs/Documents',
    description: `Create a new Google Docs document.

    Usage examples:
    
    1. Create empty document:
       { "email": "user@example.com", "title": "Meeting Notes" }
    
    2. Create with initial content:
       { "email": "user@example.com", "title": "Project Plan", "content": "# Overview\\n\\nThis document outlines..." }
    
    Returns the new document's ID and URL.`,
    aliases: ['create_doc', 'new_document', 'make_document'],
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Google account'
        },
        title: {
          type: 'string',
          description: 'Title for the new document'
        },
        content: {
          type: 'string',
          description: 'Optional initial content for the document'
        }
      },
      required: ['title']
    }
  },
  {
    name: 'append_to_workspace_document',
    category: 'Docs/Documents',
    description: `Append text to the end of a Google Docs document.

    Without tab_id this acts on the first tab. Pass tab_id to append to the end of one tab.
    ${TAB_LINK_NOTE}

    Usage examples:
    
    1. Simple append:
       { "email": "user@example.com", "document_id": "1ABC123xyz", "text": "\\n\\n## New Section\\n\\nAdditional content here." }

    2. Append to one tab:
       { "email": "user@example.com", "document_id": "1ABC123xyz", "tab_id": "t.abc123", "text": "\\nAction items reviewed." }
    
    The text is inserted at the end of the document body (or of the tab).
    Use \\n for line breaks in the appended text.`,
    aliases: ['append_doc', 'add_to_document', 'document_append'],
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Google account'
        },
        document_id: {
          type: 'string',
          description: 'Google Docs document ID'
        },
        text: {
          type: 'string',
          description: 'Text to append to the document'
        },
        tab_id: {
          type: 'string',
          description: 'Tab id from list_workspace_document_tabs. "default" means the first tab.'
        }
      },
      required: ['document_id', 'text']
    }
  },
  {
    name: 'replace_workspace_document',
    category: 'Docs/Documents',
    description: `Replace the entire content of a Google Docs document.

    WARNING: This completely replaces all existing content. Use with caution.

    Without tab_id this acts on the first tab. Pass tab_id to replace the content of one tab only
    (its sub-tabs are separate tabs and are not touched). ${TAB_LINK_NOTE}

    Usage examples:
    
    1. Complete rewrite:
       { "email": "user@example.com", "document_id": "1ABC123xyz", "content": "# New Document Content\\n\\nThis replaces everything." }

    2. Rewrite one tab:
       { "email": "user@example.com", "document_id": "1ABC123xyz", "tab_id": "t.abc123", "content": "Agenda\\n\\n- Updates" }
    
    For partial edits, consider using find_and_replace_workspace_document instead.`,
    aliases: ['replace_doc', 'overwrite_document', 'rewrite_document'],
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Google account'
        },
        document_id: {
          type: 'string',
          description: 'Google Docs document ID'
        },
        content: {
          type: 'string',
          description: 'New content to replace entire document'
        },
        tab_id: {
          type: 'string',
          description: 'Tab id from list_workspace_document_tabs. "default" means the first tab.'
        }
      },
      required: ['document_id', 'content']
    }
  },
  {
    name: 'find_and_replace_workspace_document',
    category: 'Docs/Documents',
    description: `Find and replace text throughout a Google Docs document.

    Without tab_id this replaces in every tab; pass tab_id to limit it to one tab (sub-tabs are
    separate tabs and are not included). ${TAB_LINK_NOTE}

    Usage examples:
    
    1. Simple replacement:
       { "email": "user@example.com", "document_id": "1ABC123xyz", "find_text": "old text", "replace_text": "new text" }
    
    2. Case-sensitive replacement:
       { "email": "user@example.com", "document_id": "1ABC123xyz", "find_text": "TODO", "replace_text": "DONE", "match_case": true }

    3. Replace a date placeholder in one tab only:
       { "email": "user@example.com", "document_id": "1ABC123xyz", "tab_id": "t.abc123", "find_text": "{{date}}", "replace_text": "2031-10-13" }
       Without tab_id a placeholder that also sits in a Template tab is replaced there too.
    
    Returns the number of occurrences replaced.
    Note: This replaces ALL occurrences of the text in every tab it covers.`,
    aliases: ['find_replace_doc', 'search_replace_document', 'document_find_replace'],
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Google account'
        },
        document_id: {
          type: 'string',
          description: 'Google Docs document ID'
        },
        find_text: {
          type: 'string',
          description: 'Text to find'
        },
        replace_text: {
          type: 'string',
          description: 'Text to replace with'
        },
        match_case: {
          type: 'boolean',
          description: 'Case-sensitive matching (default: false)'
        },
        tab_id: {
          type: 'string',
          description: 'Tab id from list_workspace_document_tabs. "default" means the first tab.'
        }
      },
      required: ['document_id', 'find_text', 'replace_text']
    }
  },
  {
    name: 'extract_workspace_document_id',
    category: 'Docs/Documents',
    description: `Extract a Google Docs document ID from a URL or validate an existing ID.

    This is a utility tool that helps parse various Google Docs URL formats.

    Supported formats:
    - https://docs.google.com/document/d/{id}/edit
    - https://docs.google.com/document/d/{id}/edit?...
    - https://docs.google.com/document/d/{id}
    - Just the document ID itself

    Usage examples:
    
    1. Extract from URL:
       { "input": "https://docs.google.com/document/d/1ABC123xyz/edit" }
    
    2. Validate existing ID:
       { "input": "1ABC123xyz" }
    
    Returns the extracted/validated document ID.`,
    aliases: ['parse_doc_url', 'get_doc_id', 'document_id_from_url'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        input: {
          type: 'string',
          description: 'Google Docs URL or document ID to parse'
        }
      },
      required: ['input']
    }
  },
  {
    name: 'list_workspace_document_tabs',
    category: 'Docs/Documents',
    description: `List every tab in a Google Docs document, including nested sub-tabs.

    Returns the tab tree: one line per tab, indented by nesting level and numbered by position
    (1., 1.1., 1.1.1.), with its tab id and number of sub-tabs. Use a tab id as tab_id in
    read_workspace_document, append_to_workspace_document, replace_workspace_document and
    find_and_replace_workspace_document. ${TAB_LINK_NOTE}

    Usage examples:
    
    1. List tabs:
       { "email": "user@example.com", "document_id": "1ABC123xyz" }
    
    2. Include word count:
       { "email": "user@example.com", "document_id": "1ABC123xyz", "include_word_count": true }

    3. As JSON (flat list in tree order with tabId, title, parentTabId, index, nestingLevel, path, childCount):
       { "email": "user@example.com", "document_id": "1ABC123xyz", "return_json": true }
    
    Returns tab information including title and optional word count. include_word_count reads
    every tab's content, so it is slower on large documents.`,
    aliases: ['list_doc_tabs', 'get_document_tabs', 'document_tabs'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Google account'
        },
        document_id: {
          type: 'string',
          description: 'Google Docs document ID'
        },
        include_word_count: {
          type: 'boolean',
          description: 'Include word count for each tab (default: false)'
        },
        return_json: {
          type: 'boolean',
          description: 'Return the tab list as JSON instead of formatted text (default: false)'
        }
      },
      required: ['document_id']
    }
  },
  {
    name: 'batch_update_workspace_document',
    category: 'Docs/Documents',
    description: `Execute multiple updates to a Google Docs document in a single request.

    This is the low-level API for modifying documents. It accepts an array of request objects
    that are passed directly to the Google Docs API batchUpdate endpoint.

    Common request types include:
    - insertText: Insert text at a specific location (index-based)
    - deleteContentRange: Delete a range of content by start/end index
    - replaceAllText: Find and replace text throughout the document
    - updateTextStyle: Format text (bold, italic, underline, font, color, link, etc.)
    - updateParagraphStyle: Change paragraph alignment, spacing, indentation, heading level
    - createParagraphBullets: Add bullet or numbered list formatting to paragraphs
    - insertInlineImage: Insert an image from a URL at a specific location
    - insertTable: Insert a table with specified rows and columns
    - insertTableRow/insertTableColumn: Add rows or columns to existing tables
    - deleteTableRow/deleteTableColumn: Remove rows or columns from tables
    - mergeTableCells/unmergeTableCells: Merge or unmerge table cells
    - createNamedRange: Create a named range for bookmarking content
    - insertPageBreak: Insert a page break
    - createHeader/createFooter: Add headers or footers

    Usage examples:

    1. Insert text at the beginning of the document:
       {
         "email": "user@example.com",
         "document_id": "1ABC123xyz",
         "requests": [
           { "insertText": { "location": { "index": 1 }, "text": "Hello World\\n" } }
         ]
       }

    2. Delete a range of content:
       {
         "email": "user@example.com",
         "document_id": "1ABC123xyz",
         "requests": [
           { "deleteContentRange": { "range": { "startIndex": 5, "endIndex": 20 } } }
         ]
       }

    3. Replace all occurrences of text:
       {
         "email": "user@example.com",
         "document_id": "1ABC123xyz",
         "requests": [
           { "replaceAllText": { "containsText": { "text": "{{placeholder}}", "match_case": true }, "replace_text": "Actual Value" } }
         ]
       }

    4. Bold a range of text:
       {
         "email": "user@example.com",
         "document_id": "1ABC123xyz",
         "requests": [
           { "updateTextStyle": { "range": { "startIndex": 1, "endIndex": 12 }, "textStyle": { "bold": true }, "fields": "bold" } }
         ]
       }

    5. Add bullet points to paragraphs:
       {
         "email": "user@example.com",
         "document_id": "1ABC123xyz",
         "requests": [
           { "createParagraphBullets": { "range": { "startIndex": 1, "endIndex": 50 }, "bulletPreset": "BULLET_DISC_CIRCLE_SQUARE" } }
         ]
       }

    6. Insert a table:
       {
         "email": "user@example.com",
         "document_id": "1ABC123xyz",
         "requests": [
           { "insertTable": { "location": { "index": 1 }, "rows": 3, "columns": 4 } }
         ]
       }

    7. Insert an inline image:
       {
         "email": "user@example.com",
         "document_id": "1ABC123xyz",
         "requests": [
           { "insertInlineImage": { "location": { "index": 1 }, "uri": "https://example.com/image.png", "objectSize": { "width": { "magnitude": 300, "unit": "PT" }, "height": { "magnitude": 200, "unit": "PT" } } } }
         ]
       }

    8. Multiple operations with revision control:
       {
         "email": "user@example.com",
         "document_id": "1ABC123xyz",
         "requests": [
           { "replaceAllText": { "containsText": { "text": "{{date}}" }, "replace_text": "2025-01-15" } },
           { "replaceAllText": { "containsText": { "text": "{{author}}" }, "replace_text": "John Doe" } }
         ],
         "write_control": { "requiredRevisionId": "abc123" }
       }

    Note: Changes are atomic - if any request fails, none are applied. Use return_json: true
    to see the full API response including detailed replies per request.

    Returns: Success message with update count, or raw API response with return_json: true.

    Reference: https://developers.google.com/docs/api/reference/rest/v1/documents/batchUpdate`,
    aliases: ['batch_update_doc', 'update_document', 'modify_document'],
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Google account'
        },
        document_id: {
          type: 'string',
          description: 'Google Docs document ID or URL'
        },
        requests: {
          type: 'array',
          items: {
            type: 'object'
          },
          description: 'Array of update request objects (see Google Docs API reference for schema)'
        },
        write_control: {
          type: 'object',
          properties: {
            requiredRevisionId: {
              type: 'string',
              description: 'Revision ID for optimistic concurrency control (optional)'
            }
          },
          description: 'Optional write control settings'
        },
        return_json: {
          type: 'boolean',
          description: 'Return raw API response instead of formatted text (default: false)'
        }
      },
      required: ['document_id', 'requests']
    }
  }
];
